import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppClient } from '../../data/client';
import type { OwnerScope } from '../../auth/session';
import type { WardrobeItem } from '../../domain/wardrobe';
import { loadWardrobe } from '../../data/items';
import { loadWearHistory, type WearHistory } from '../../data/wear-history';
import { errorKey, isAborted } from '../../data/errors';
import type { Language, MessageKey } from '../../i18n';
import { emptyFacets, filterItems, sortItems, wearSort, type Facets, type WardrobeSort } from './search';

export function useWardrobeBrowse(client: AppClient, scope: OwnerScope, language: Language, online: boolean) {
  const [items, setItems] = useState<WardrobeItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<Facets>(emptyFacets);
  const [sort, setSort] = useState<WardrobeSort>('newest');
  const [requestedSort, setRequestedSort] = useState<WardrobeSort>('newest');
  const [history, setHistory] = useState<WearHistory | null>(null);
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [viewWindow, setViewWindow] = useState({ count: 40, language });
  const current = useRef({
    items: null as WardrobeItem[] | null, sort: 'newest' as WardrobeSort,
    requested: 'newest' as WardrobeSort, history: null as WearHistory | null,
    retry: 'newest' as WardrobeSort, sequence: 0, request: new AbortController(),
  });
  const cancel = useCallback(() => {
    current.current.sequence++;
    current.current.request.abort();
  }, []);
  const replaceItems = useCallback((next: WardrobeItem[]) => {
    current.current.items = next;
    setItems(next);
  }, []);
  const execute = useCallback(async (refresh: boolean, desired: WardrobeSort) => {
    cancel();
    const state = current.current, sequence = state.sequence;
    state.request = new AbortController();
    state.requested = desired;
    state.retry = desired;
    setRequestedSort(desired);
    setError(null); setHistoryError(false);
    setLoading(refresh);
    setHistoryLoading(wearSort(desired));
    const signal = state.request.signal;
    const valid = () => !scope.signal.aborted && !signal.aborted && sequence === state.sequence;
    let readingHistory = false;
    try {
      const next = refresh ? await loadWardrobe(client, scope, signal) : state.items;
      if (!next || !valid()) return;
      const cachedHistory = refresh ? null : state.history;
      let nextHistory = cachedHistory;
      if (wearSort(desired)) {
        // Remove newly known absences even if the subsequent history read fails.
        if (refresh && state.items) {
          const ids = new Set(next.map(item => item.id));
          replaceItems(state.items.filter(item => ids.has(item.id)));
        }
        if (!online) {
          if (!cachedHistory || next.some(item => !cachedHistory.items.has(item.id))) {
            setHistoryError(true); setRequestedSort(state.sort); state.requested = state.sort;
            return;
          }
        } else if (refresh || !cachedHistory || cachedHistory.ownerId !== scope.ownerId || cachedHistory.epoch !== scope.epoch
          || next.some(item => !cachedHistory.items.has(item.id))) {
          readingHistory = true;
          nextHistory = await loadWearHistory(client, scope, next, signal);
        }
      }
      if (!valid()) return;
      state.history = nextHistory;
      state.sort = desired;
      setHistory(nextHistory); setSort(desired);
      replaceItems(next);
    } catch (problem) {
      if (!valid() || isAborted(problem)) return;
      if (readingHistory) setHistoryError(true);
      else setError(errorKey(problem));
      state.requested = state.sort; setRequestedSort(state.sort);
    } finally {
      if (valid()) { setLoading(false); setHistoryLoading(false); }
    }
  }, [cancel, client, online, replaceItems, scope]);
  const refresh = useCallback(() => {
    if (online) void execute(true, current.current.requested);
  }, [execute, online]);
  useEffect(() => {
    if (online && current.current.items === null) refresh();
  }, [online, refresh]);
  useEffect(() => {
    const clear = () => {
      cancel(); current.current.items = null; current.current.history = null;
      setItems(null); setHistory(null); setQuery(''); setFacets(emptyFacets());
      setSort('newest'); setRequestedSort('newest'); setError(null); setHistoryError(false);
    };
    scope.signal.addEventListener('abort', clear, { once: true });
    return () => { scope.signal.removeEventListener('abort', clear); cancel(); };
  }, [cancel, scope]);
  function chooseSort(next: WardrobeSort) {
    setViewWindow({ count: 40, language });
    if (wearSort(next)) { void execute(false, next); return; }
    cancel();
    current.current.sort = next; current.current.requested = next;
    setSort(next); setRequestedSort(next); setHistoryError(false); setHistoryLoading(false); setLoading(false);
  }
  function remove(id: string) {
    cancel(); setLoading(false); setHistoryLoading(false);
    current.current.requested = current.current.sort;
    setRequestedSort(current.current.sort);
    replaceItems((current.current.items ?? []).filter(item => item.id !== id));
  }
  const results = useMemo(() => sortItems(filterItems(items ?? [], query, facets, language), sort, language, history), [items, query, facets, language, sort, history]);
  const count = viewWindow.language === language ? Math.max(40, Math.min(viewWindow.count, Math.ceil(results.length / 40) * 40)) : 40;
  if (viewWindow.language !== language || viewWindow.count !== count) setViewWindow({ count, language });
  return {
    items: items ?? [], initialized: items !== null, results, visible: results.slice(0, count), query, facets, sort,
    requestedSort, loading, historyLoading, error, historyError,
    setQuery: (value: string) => { setQuery(value.slice(0, 512)); setViewWindow({ count: 40, language }); },
    setFacets: (value: Facets) => { setFacets(value); setViewWindow({ count: 40, language }); },
    clear: () => { setQuery(''); setFacets(emptyFacets()); setViewWindow({ count: 40, language }); },
    showMore: () => setViewWindow({ count: count + 40, language }),
    chooseSort, remove, refresh,
    retryHistory: () => { if (online) void execute(true, current.current.retry); },
  };
}
export type WardrobeBrowse = ReturnType<typeof useWardrobeBrowse>;
