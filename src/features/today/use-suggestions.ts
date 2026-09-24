import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { errorKey, isAborted } from '../../data/errors';
import { loadWardrobe } from '../../data/items';
import { clearVote, loadSuggestionInputs, setVote, type Vote } from '../../data/suggestions';
import type { Occasion } from '../../domain/outfits';
import {
  combinationKey, recommend, seasonForDate, type EngineFeedback, type EngineItem, type Season, type SuggestionResult,
} from '../../domain/recommendations';
import type { WardrobeItem } from '../../domain/wardrobe';
import type { MessageKey } from '../../i18n';

export function engineItem(item: WardrobeItem): EngineItem {
  return {
    id: item.id, ownerId: item.ownerId, category: item.category, colours: item.colours, seasons: item.seasons,
    formality: item.formality, warmth: null, lowerCoverage: null, minTemp: null, maxTemp: null, rainRating: null, windproof: null,
    favourite: item.favourite, availability: item.availability, lifecycle: item.lifecycle,
    excludeSuggestions: item.excludeSuggestions, deleted: false,
  };
}

// Only active clothes with a ready photo are offered; loadWardrobe already drops items whose photo is not ready.
export function suggestionPool(items: readonly WardrobeItem[]): EngineItem[] {
  return items.filter(item => item.lifecycle === 'active' && item.imageId !== '').map(engineItem);
}

export function localDate(timeZone: string, now: Date): string {
  const format = (zone?: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  try { return format(timeZone); } catch { return format(); }
}
export function defaultSeason(timeZone: string, now = new Date()): Season {
  return seasonForDate(localDate(timeZone, now));
}

type Data = { items: WardrobeItem[]; excludedPairs: [string, string][] };
// Ideas are ranked with the votes known when the page was drawn, so a Like never moves a card.
type Run = { feedback: EngineFeedback[]; skip: ReadonlySet<string>; paged: boolean };
export type Pending = { key: string; kind: 'like' | 'hide' | 'undo' };

const votesFrom = (feedback: readonly EngineFeedback[]) => new Map(feedback.map(entry => [combinationKey(entry.itemIds), entry.vote]));
const feedbackFrom = (votes: ReadonlyMap<string, Vote>): EngineFeedback[] =>
  [...votes].map(([key, vote]) => ({ itemIds: key.split('|'), vote }));

export function useSuggestions(client: AppClient, scope: OwnerScope, online: boolean, invalidation: number, occasion: Occasion, season: Season) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [tick, setTick] = useState(0);
  const [votes, setVotes] = useState<Map<string, Vote>>(() => new Map());
  const [run, setRun] = useState<Run>({ feedback: [], skip: new Set(), paged: false });
  const [pending, setPending] = useState<Pending | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const wasOnline = useRef(online);
  const votesRef = useRef(votes);
  const writes = useRef<AbortController | null>(null);
  const reload = useCallback(() => setTick(value => value + 1), []);
  useEffect(() => { votesRef.current = votes; }, [votes]);
  useEffect(() => {
    if (online && !wasOnline.current) reload();
    wasOnline.current = online;
  }, [online, reload]);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    Promise.all([loadWardrobe(client, scope, controller.signal), loadSuggestionInputs(client, scope, controller.signal)]).then(([items, inputs]) => {
      if (controller.signal.aborted || scope.signal.aborted) return;
      setData({ items, excludedPairs: inputs.excludedPairs });
      setVotes(votesFrom(inputs.feedback));
      setRun(current => ({ ...current, feedback: inputs.feedback }));
    }, (problem: unknown) => {
      if (!controller.signal.aborted && !isAborted(problem)) setError(errorKey(problem));
    });
    return () => controller.abort();
  }, [client, scope, tick, invalidation]);
  useEffect(() => {
    const controller = new AbortController();
    writes.current = controller;
    return () => controller.abort();
  }, []);
  // A new occasion or season starts again from the first ideas.
  useEffect(() => {
    setRun({ feedback: feedbackFrom(votesRef.current), skip: new Set(), paged: false });
    setFailed(null);
  }, [occasion, season]);

  const engineItems = useMemo(() => suggestionPool(data?.items ?? []), [data]);
  const result: SuggestionResult | null = useMemo(() => data ? recommend({
    items: engineItems, context: { ownerId: scope.ownerId, occasion, season },
    feedback: run.feedback, excludedPairs: data.excludedPairs, skip: run.skip,
  }) : null, [data, engineItems, scope.ownerId, occasion, season, run]);

  const more = useCallback(() => {
    if (!result) return;
    const shown = result.suggestions.map(suggestion => suggestion.coreKey);
    setRun(current => ({ feedback: feedbackFrom(votesRef.current), skip: new Set([...current.skip, ...shown]), paged: true }));
    setFailed(null);
  }, [result]);
  const startOver = useCallback(() => {
    setRun({ feedback: feedbackFrom(votesRef.current), skip: new Set(), paged: false });
    setFailed(null);
  }, []);

  const write = useCallback(async (key: string, kind: Pending['kind'], next: Vote | null) => {
    const signal = writes.current?.signal;
    if (!signal || pending || !online) return;
    setPending({ key, kind }); setFailed(null);
    try {
      const ids = key.split('|');
      if (next === null) await clearVote(client, scope, ids, signal);
      else await setVote(client, scope, ids, next, signal);
      if (signal.aborted || scope.signal.aborted) return;
      setVotes(current => {
        const updated = new Map(current);
        if (next === null) updated.delete(key); else updated.set(key, next);
        return updated;
      });
    } catch (problem) {
      if (!signal.aborted && !isAborted(problem)) setFailed(key);
    } finally {
      if (!signal.aborted) setPending(null);
    }
  }, [client, scope, online, pending]);

  return {
    data, error, result, votes, pending, failed, paged: run.paged, reload, more, startOver,
    hasClothes: Boolean(data?.items.some(item => item.lifecycle === 'active')),
    like: (key: string) => { void write(key, 'like', votes.get(key) === 1 ? null : 1); },
    hide: (key: string) => { void write(key, 'hide', -1); },
    undo: (key: string) => { void write(key, 'undo', null); },
  };
}
