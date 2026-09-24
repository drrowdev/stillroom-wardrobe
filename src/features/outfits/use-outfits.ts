import { useCallback, useEffect, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { errorKey, isAborted } from '../../data/errors';
import { loadWardrobe } from '../../data/items';
import { loadComponents, loadOutfit, loadOutfits } from '../../data/outfits';
import type { MessageKey } from '../../i18n';
import type { OutfitComponent, OutfitRecord } from '../../domain/outfits';
import type { WardrobeItem } from '../../domain/wardrobe';

type Loaded<T> = { data: T | null; error: MessageKey | null; loading: boolean };

// Refetches on invalidation, when the app comes back online and on window focus. The latest request wins.
function useLoaded<T>(load: (signal: AbortSignal) => Promise<T>, online: boolean, invalidation: number): Loaded<T> & { reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const wasOnline = useRef(online);
  const reload = useCallback(() => setTick(value => value + 1), []);
  useEffect(() => {
    if (online && !wasOnline.current) reload();
    wasOnline.current = online;
  }, [online, reload]);
  useEffect(() => {
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, [reload]);
  useEffect(() => {
    const controller = new AbortController();
    setState(current => ({ ...current, loading: true }));
    load(controller.signal).then(data => {
      if (!controller.signal.aborted) setState({ data, error: null, loading: false });
    }, (problem: unknown) => {
      if (!controller.signal.aborted && !isAborted(problem)) setState(current => ({ ...current, error: errorKey(problem), loading: false }));
    });
    return () => controller.abort();
  }, [load, tick, invalidation]);
  return { ...state, reload };
}

export type OutfitList = { outfits: OutfitRecord[]; components: Map<string, OutfitComponent>; hasClothes: boolean };
export function useOutfitList(client: AppClient, scope: OwnerScope, online: boolean, invalidation: number) {
  const load = useCallback(async (signal: AbortSignal): Promise<OutfitList> => {
    const [outfits, wardrobe] = await Promise.all([loadOutfits(client, scope, signal), loadWardrobe(client, scope, signal)]);
    const components = await loadComponents(client, scope, outfits.flatMap(outfit => outfit.links.map(link => link.itemId)), signal);
    return { outfits, components, hasClothes: wardrobe.some(item => item.lifecycle === 'active') };
  }, [client, scope]);
  return useLoaded(load, online, invalidation);
}

export type OutfitView = { record: OutfitRecord | null; components: Map<string, OutfitComponent> };
export function useOutfit(client: AppClient, scope: OwnerScope, id: string | null, online: boolean, invalidation: number) {
  const missingReload = useRef(false);
  const load = useCallback(async (signal: AbortSignal): Promise<OutfitView> => {
    const record = id ? await loadOutfit(client, scope, id, signal) : null;
    if (!record || record.deletedAt !== null) return { record: null, components: new Map() };
    const components = await loadComponents(client, scope, record.links.map(link => link.itemId), signal);
    // A link whose item cannot be read is reloaded once; a completed deletion then shows as a gap.
    if (missingReload.current || ![...components.values()].some(component => component.state === 'missing')) return { record, components };
    missingReload.current = true;
    const again = await loadOutfit(client, scope, record.id, signal);
    if (!again || again.deletedAt !== null) return { record: null, components: new Map() };
    return { record: again, components: await loadComponents(client, scope, again.links.map(link => link.itemId), signal) };
  }, [client, scope, id]);
  return useLoaded(load, online, invalidation);
}

export function usePickerItems(client: AppClient, scope: OwnerScope, online: boolean, invalidation: number) {
  const load = useCallback(async (signal: AbortSignal): Promise<WardrobeItem[]> =>
    (await loadWardrobe(client, scope, signal)).filter(item => item.lifecycle === 'active'), [client, scope]);
  return useLoaded(load, online, invalidation);
}

// Current state of every selected garment, whatever its lifecycle or trash state.
export function useDraftComponents(client: AppClient, scope: OwnerScope, ids: readonly string[], online: boolean, invalidation: number) {
  const key = [...new Set(ids)].sort().join(',');
  const load = useCallback(async (signal: AbortSignal): Promise<Map<string, OutfitComponent>> =>
    key ? loadComponents(client, scope, key.split(','), signal) : new Map(), [client, scope, key]);
  return useLoaded(load, online, invalidation);
}

export function pickerComponent(item: WardrobeItem): OutfitComponent {
  return {
    id: item.id, state: 'current', title: item.title, category: item.category,
    colour: item.colours[0] ?? null, lifecycle: item.lifecycle, thumbPath: item.thumbPath, altText: item.altText,
  };
}
