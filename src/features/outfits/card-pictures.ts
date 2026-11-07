// OUTFITS-PICTURES: the owner's existing try-on pictures on the saved-outfit cards. Reads only (the saved-results list and the
// picture bytes); nothing here starts a try-on. Everything is held in memory for the life of the screen.
import { useEffect, useMemo, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import type { TryOnClient, TryOnResult } from '../../data/tryon';
import { newestOutfitPicture, plannedKey } from '../../domain/outfitgen-pictures';
import type { OutfitComponent, OutfitRecord } from '../../domain/outfits';
import { tryOnStoreFor } from '../settings/tryon-store';
import { tryOnSelection, useTryOnStatus } from './use-try-on';

/** At most this many pictures are fetched at once on a long list. */
export const CARD_PICTURE_CONCURRENCY = 3;

export type PictureLoader = { load: (id: string, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer> | null> };

/** Runs `work` with at most `max` in flight, in the order asked. A caller aborted while waiting never starts. */
export function limiter(max: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  const acquire = (signal: AbortSignal) => new Promise<boolean>((resolve) => {
    if (signal.aborted) { resolve(false); return; }
    if (active < max) { active += 1; resolve(true); return; }
    const grant = () => { signal.removeEventListener('abort', cancel); active += 1; resolve(true); };
    const cancel = () => { const at = waiting.indexOf(grant); if (at >= 0) waiting.splice(at, 1); resolve(false); };
    waiting.push(grant);
    signal.addEventListener('abort', cancel, { once: true });
  });
  const release = () => { active -= 1; waiting.shift()?.(); };
  return async function run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T | null> {
    if (!(await acquire(signal))) return null;
    try { return await work(); } finally { release(); }
  };
}

export function pictureLoader(api: TryOnClient, max = CARD_PICTURE_CONCURRENCY): PictureLoader {
  const run = limiter(max);
  return {
    load: (id, signal) => run(signal, async () => {
      try {
        const image = await api.resultImage(id, signal);
        return image.kind === 'image' ? image.bytes : null;
      } catch { return null; }
    }),
  };
}

/**
 * The saved-results list is read once per list load, and only while online and while the account has saved pictures (the same gate
 * as the outfit detail). A missing, failed or offline read gives no pictures and no message: the cards keep their collage.
 */
export function useOutfitListPictures(client: AppClient, scope: OwnerScope, online: boolean,
  outfits: readonly OutfitRecord[] | null, components: ReadonlyMap<string, OutfitComponent> | null): { loader: PictureLoader | null; pictures: ReadonlyMap<string, string> } {
  const store = tryOnStoreFor(client, scope);
  const listed = outfits !== null && outfits.length > 0;
  // No saved outfits: nothing to show a picture on, so the try-on status is not even read.
  const status = useTryOnStatus(listed ? store : null);
  const enabled = online && status !== null && status.results > 0;
  const api = store?.api ?? null;
  const [results, setResults] = useState<readonly TryOnResult[]>([]);
  const loader = useMemo(() => api ? pictureLoader(api) : null, [api]);
  useEffect(() => {
    if (!api || !enabled || !listed) { setResults([]); return; }
    const controller = new AbortController();
    api.results(controller.signal).then(list => {
      if (!controller.signal.aborted) setResults(list === 'missing' ? [] : list);
    }, () => { if (!controller.signal.aborted) setResults([]); });
    return () => controller.abort();
  }, [api, enabled, listed, outfits]);
  const pictures = useMemo(() => {
    const found = new Map<string, string>();
    if (!results.length || !outfits || !components) return found;
    for (const outfit of outfits) {
      const match = newestOutfitPicture(results, outfit.id, plannedKey(tryOnSelection(outfit, components).steps));
      if (match) found.set(outfit.id, match.id);
    }
    return found;
  }, [results, outfits, components]);
  return { loader, pictures };
}

/** The picture's Blob URL once it is loaded (revoked when replaced or unmounted); null while waiting, or if it could not be loaded. */
export function useCardPicture(loader: PictureLoader | null, id: string | null): string | null {
  const [shown, setShown] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!loader || id === null) return;
    const controller = new AbortController();
    let url: string | null = null;
    void loader.load(id, controller.signal).then(bytes => {
      if (controller.signal.aborted || !bytes) return;
      url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      setShown({ id, url });
    });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); setShown(current => current?.id === id ? null : current); };
  }, [loader, id]);
  return shown !== null && shown.id === id ? shown.url : null;
}
