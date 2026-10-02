import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { catalogueLoaded, languages, type Language } from './index';
import { ensureCatalogue } from './load';

// LANG1: the language actually displayed. `shown` is always a language whose catalogue is installed; a requested
// language that is not yet loaded keeps the current one until it arrives, and only the latest request can switch.
export type Display = { requested: Language; shown: Language; failed: Language | null };

export function initialDisplay(requested: Language, loaded: (language: Language) => boolean): Display {
  return { requested, shown: loaded(requested) ? requested : languages.find(loaded) ?? requested, failed: null };
}
export function requestDisplay(state: Display, requested: Language, loaded: (language: Language) => boolean): Display {
  if (loaded(requested)) return { requested, shown: requested, failed: null };
  return { requested, shown: state.shown, failed: state.failed === requested ? requested : null };
}
export function settleDisplay(state: Display, language: Language, ok: boolean): Display {
  if (language !== state.requested) return state;
  return ok ? { requested: language, shown: language, failed: null } : { ...state, failed: language };
}

export type DisplayLanguage = { shown: Language; pending: Language | null; failed: Language | null; retry: () => void };

export function useDisplayLanguage(requested: Language, load: (language: Language) => Promise<void> = ensureCatalogue): DisplayLanguage {
  const [state, setState] = useState(() => initialDisplay(requested, catalogueLoaded));
  const [attempt, retry] = useReducer((value: number) => value + 1, 0);
  const latest = useRef(requested);
  latest.current = requested;
  // A loaded request applies in the same render, so a switch to a loaded language never shows a frame of the old one.
  const current = state.requested === requested ? state : requestDisplay(state, requested, catalogueLoaded);
  if (current !== state) setState(current);
  useEffect(() => {
    if (catalogueLoaded(requested)) return;
    let live = true;
    setState((value) => value.requested === requested && value.failed !== null ? { ...value, failed: null } : value);
    load(requested).then(
      () => { if (live && latest.current === requested) setState((value) => settleDisplay(value, requested, true)); },
      () => { if (live && latest.current === requested) setState((value) => settleDisplay(value, requested, false)); },
    );
    return () => { live = false; };
  }, [requested, attempt, load]);
  const shown = catalogueLoaded(current.requested) ? current.requested : current.shown;
  const failed = current.failed === requested && !catalogueLoaded(requested) ? requested : null;
  return {
    shown,
    pending: shown !== requested && failed === null ? requested : null,
    failed,
    retry: useCallback(() => retry(), []),
  };
}
export type ChooserRequest = { token: number; context: object };
/** True only while the request is the latest one, made in the current entry context, by a mounted chooser. */
export function requestCurrent(request: ChooserRequest, latest: { token: number; context: object; mounted: boolean }): boolean {
  return latest.mounted && request.token === latest.token && request.context === latest.context;
}
