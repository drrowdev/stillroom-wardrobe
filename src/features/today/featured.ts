import type { WeatherContext } from './use-suggestions';

// Today shows the ideas of the current page together. The page itself (its ideas, order and paging) stays with
// useSuggestions; this only pins which ideas are showing, by key, so a refreshed list can drop a card but never swaps in
// or reorders one. When every pinned idea has gone, the ideas of the list not shown before are pinned in their place;
// otherwise new ideas appear only through Show other ideas. `seen` holds every idea pinned so far, so none is shown twice.
// `armed` is false for the render in which a context change is still reaching useSuggestions; until then nothing is pinned.
export type Page = { readonly token: string; readonly keys: readonly string[] | null; readonly seen: readonly string[]; readonly armed: boolean };

export const pageStart = (token: string, armed = true): Page => ({ token, keys: null, seen: [], armed });

// The ideas to show for a (possibly refreshed) list: the pinned ones still in the list, in their pinned order.
export function pinPage(keys: readonly string[], state: Page): { state: Page; shown: readonly string[] } {
  if (!state.armed) return { state, shown: keys };
  const kept = state.keys?.filter(key => keys.includes(key)) ?? [];
  if (kept.length) return { state, shown: kept };
  const fresh = keys.filter(key => !state.seen.includes(key));
  if (!fresh.length) return { state, shown: [] };
  return { state: { ...state, keys: fresh, seen: [...state.seen, ...fresh] }, shown: fresh };
}

// The same fields, in the same order, as useSuggestions' own weather id, so Today starts again from the first ideas on the
// same render the hook does.
export const weatherRunId = (weather: WeatherContext) =>
  JSON.stringify([weather.setting ?? null, weather.temperatureC ?? null, weather.rainProbability ?? null, weather.windMetresPerSecond ?? null]);

// What resets the pinned page: an explicit page change or a change of occasion, season or applied weather.
// A data refresh is not one of them.
export const transitionToken = (page: number, occasion: string, season: string, weatherId: string) => JSON.stringify([page, occasion, season, weatherId]);
