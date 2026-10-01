import type { WeatherContext } from './use-suggestions';

// Today shows one idea of the current page at a time. The page itself (its ideas, order and paging) stays with
// useSuggestions; this only tracks which idea is featured, by key, so a refreshed list never repeats or skips one.
// `armed` is false for the render in which a context change is still reaching useSuggestions; until then nothing is pinned.
export type Featured = {
  readonly token: string; readonly current: string | null; readonly seen: readonly string[]; readonly number: number; readonly armed: boolean;
};
export type Shown = { kind: 'idea'; key: string; number: number } | { kind: 'gone' };

export const featuredStart = (token: string, number = 1, armed = true): Featured => ({ token, current: null, seen: [], number, armed });

// The idea to show for a (possibly refreshed) list: the current one wherever it now sits, otherwise the first one not
// shown yet in the list's current order, which then becomes current. Reconciling never clears what was seen and never pages.
export function reconcile(keys: readonly string[], state: Featured): { state: Featured; shown: Shown } {
  if (!state.armed) {
    const first = keys.find(key => !state.seen.includes(key));
    return { state, shown: first === undefined ? { kind: 'gone' } : { kind: 'idea', key: first, number: state.number } };
  }
  if (state.current !== null && keys.includes(state.current)) return { state, shown: { kind: 'idea', key: state.current, number: state.number } };
  const following = keys.find(key => key !== state.current && !state.seen.includes(key));
  if (following === undefined) return { state, shown: { kind: 'gone' } };
  const seen = state.current === null || state.seen.includes(state.current) ? state.seen : [...state.seen, state.current];
  return { state: { ...state, current: following, seen }, shown: { kind: 'idea', key: following, number: state.number } };
}

// Show another: the shown idea counts as seen, and the first unseen one in the current order follows. 'page' means the
// page has no more, so the caller asks useSuggestions for the next page.
export function next(keys: readonly string[], state: Featured): Featured | 'page' {
  const { shown } = reconcile(keys, state);
  const seen = [...state.seen];
  for (const key of [state.current, shown.kind === 'idea' ? shown.key : null]) if (key !== null && !seen.includes(key)) seen.push(key);
  const following = keys.find(key => !seen.includes(key));
  return following === undefined ? 'page' : { token: state.token, current: following, seen, number: state.number + 1, armed: true };
}

// The same fields, in the same order, as useSuggestions' own weather id, so Today starts again from the first idea on the
// same render the hook does.
export const weatherRunId = (weather: WeatherContext) =>
  JSON.stringify([weather.setting ?? null, weather.temperatureC ?? null, weather.rainProbability ?? null, weather.windMetresPerSecond ?? null]);

// What resets the featured idea: an explicit page change or a change of occasion, season or applied weather.
// A data refresh is not one of them.
export const transitionToken = (page: number, occasion: string, season: string, weatherId: string) => JSON.stringify([page, occasion, season, weatherId]);
