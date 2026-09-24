import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { errorKey, isAborted } from '../../data/errors';
import { loadWardrobe } from '../../data/items';
import { loadSuggestionInputs, readVote, writeVote, type Vote, type WriteOutcome } from '../../data/suggestions';
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
type Unresolved = Pending & { choice: Vote | null };

const votesFrom = (feedback: readonly EngineFeedback[]) => new Map(feedback.map(entry => [combinationKey(entry.itemIds), entry.vote]));
const feedbackFrom = (votes: ReadonlyMap<string, Vote>): EngineFeedback[] =>
  [...votes].map(([key, vote]) => ({ itemIds: key.split('|'), vote }));

export type Confirmed = ReadonlyMap<string, { vote: Vote | null; seq: number }>;
// A read that started before a confirmed choice cannot know about it, so that choice wins over the snapshot.
export function mergeVotes(snapshot: ReadonlyMap<string, Vote>, confirmed: Confirmed, startSeq: number): Map<string, Vote> {
  const merged = new Map(snapshot);
  for (const [key, entry] of confirmed) {
    if (entry.seq <= startSeq) continue;
    if (entry.vote === null) merged.delete(key); else merged.set(key, entry.vote);
  }
  return merged;
}
// Ranking for a refreshed page: the fresh votes, except choices made on this page keep the value the page was ranked with.
export function rankingVotes(fresh: ReadonlyMap<string, Vote>, ranked: ReadonlyMap<string, Vote>, changed: ReadonlySet<string>): Map<string, Vote> {
  const result = new Map(fresh);
  for (const key of changed) {
    const vote = ranked.get(key);
    if (vote === undefined) result.delete(key); else result.set(key, vote);
  }
  return result;
}

export function useSuggestions(client: AppClient, scope: OwnerScope, online: boolean, invalidation: number, occasion: Occasion, season: Season) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [tick, setTick] = useState(0);
  const [votes, setVotes] = useState<Map<string, Vote>>(() => new Map());
  const [run, setRun] = useState<Run>({ feedback: [], skip: new Set(), paged: false });
  const [pending, setPending] = useState<Pending | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<Unresolved | null>(null);
  const wasOnline = useRef(online);
  const votesRef = useRef(votes);
  const writes = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const confirmed = useRef(new Map<string, { vote: Vote | null; seq: number }>());
  // Choices made on the page being shown keep their earlier ranking, so a hidden card stays in place with its Undo.
  const changedOnPage = useRef(new Set<string>());
  const reload = useCallback(() => setTick(value => value + 1), []);
  useEffect(() => { votesRef.current = votes; }, [votes]);
  useEffect(() => {
    if (online && !wasOnline.current) reload();
    wasOnline.current = online;
  }, [online, reload]);
  useEffect(() => {
    const controller = new AbortController();
    const startSeq = seq.current;
    setError(null);
    Promise.all([loadWardrobe(client, scope, controller.signal), loadSuggestionInputs(client, scope, controller.signal)]).then(([items, inputs]) => {
      if (controller.signal.aborted || scope.signal.aborted) return;
      const merged = mergeVotes(votesFrom(inputs.feedback), confirmed.current, startSeq);
      for (const [key, entry] of confirmed.current) if (entry.seq <= startSeq) confirmed.current.delete(key);
      setData({ items, excludedPairs: inputs.excludedPairs });
      setVotes(merged);
      setRun(current => ({ ...current, feedback: feedbackFrom(rankingVotes(merged, votesFrom(current.feedback), changedOnPage.current)) }));
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
    changedOnPage.current = new Set();
    setRun({ feedback: feedbackFrom(votesRef.current), skip: new Set(), paged: false });
    setFailed(null); setUnresolved(null);
  }, [occasion, season]);

  const engineItems = useMemo(() => suggestionPool(data?.items ?? []), [data]);
  const result: SuggestionResult | null = useMemo(() => data ? recommend({
    items: engineItems, context: { ownerId: scope.ownerId, occasion, season },
    feedback: run.feedback, excludedPairs: data.excludedPairs, skip: run.skip,
  }) : null, [data, engineItems, scope.ownerId, occasion, season, run]);

  const more = useCallback(() => {
    if (!result) return;
    const shown = result.suggestions.map(suggestion => suggestion.coreKey);
    changedOnPage.current = new Set();
    setRun(current => ({ feedback: feedbackFrom(votesRef.current), skip: new Set([...current.skip, ...shown]), paged: true }));
    setFailed(null); setUnresolved(null);
  }, [result]);
  const startOver = useCallback(() => {
    changedOnPage.current = new Set();
    setRun({ feedback: feedbackFrom(votesRef.current), skip: new Set(), paged: false });
    setFailed(null); setUnresolved(null);
  }, []);

  const write = useCallback(async (key: string, kind: Pending['kind'], next: Vote | null) => {
    const signal = writes.current?.signal;
    if (!signal || pending || !online) return;
    setPending({ key, kind }); setFailed(null);
    setUnresolved(current => current?.key === key ? null : current);
    const attempt = { ownerId: scope.ownerId, epoch: scope.epoch, key, choice: next };
    const settle = (stored: Vote | null) => {
      seq.current += 1;
      confirmed.current.set(key, { vote: stored, seq: seq.current });
      changedOnPage.current.add(key);
      setVotes(current => {
        const updated = new Map(current);
        if (stored === null) updated.delete(key); else updated.set(key, stored);
        return updated;
      });
    };
    let outcome: WriteOutcome | null = null;
    try {
      outcome = await writeVote(client, scope, attempt, signal);
      if (outcome === 'done') { settle(next); return; }
      if (outcome === 'unknown') {
        const stored = await readVote(client, scope, attempt, signal);
        settle(stored);
        if (stored === next) return;
      }
      setFailed(key);
    } catch (problem) {
      if (signal.aborted || isAborted(problem)) return;
      // The choice may have been stored; keep it so Try again can settle it.
      if (outcome === 'unknown') setUnresolved({ key, kind, choice: next }); else setFailed(key);
    } finally {
      if (!signal.aborted) setPending(null);
    }
  }, [client, scope, online, pending]);

  return {
    data, error, result, votes, pending, failed, unresolved: unresolved?.key ?? null, paged: run.paged, reload, more, startOver,
    retry: () => { if (unresolved) void write(unresolved.key, unresolved.kind, unresolved.choice); },
    hasClothes: Boolean(data?.items.some(item => item.lifecycle === 'active')),
    like: (key: string) => { void write(key, 'like', votes.get(key) === 1 ? null : 1); },
    hide: (key: string) => { void write(key, 'hide', -1); },
    undo: (key: string) => { void write(key, 'undo', null); },
  };
}
