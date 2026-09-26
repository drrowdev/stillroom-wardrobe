import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OwnerScope } from '../../auth/session';
import type { AppClient } from '../../data/client';
import { errorKey, isAborted } from '../../data/errors';
import { loadWardrobe } from '../../data/items';
import { loadSuggestionInputs, readPair, readVote, writePair, writeVote, type Vote, type WriteOutcome } from '../../data/suggestions';
import type { Occasion } from '../../domain/outfits';
import {
  combinationKey, pairKey, recommend, seasonForDate, type EngineContext, type EngineFeedback, type EngineItem, type Season, type Suggestion, type SuggestionResult,
} from '../../domain/recommendations';
import type { WardrobeItem } from '../../domain/wardrobe';
import type { MessageKey } from '../../i18n';

export function engineItem(item: WardrobeItem): EngineItem {
  return {
    id: item.id, ownerId: item.ownerId, category: item.category, colours: item.colours, seasons: item.seasons,
    formality: item.formality, ...item.weather,
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

// `excluded` holds the avoided pairs as canonical `low|high` keys.
type Data = { items: WardrobeItem[]; excluded: ReadonlySet<string> };
// Ideas are ranked with the votes and avoided pairs known when the page was drawn, so a choice never moves a card.
type Run = { feedback: EngineFeedback[]; excluded: ReadonlySet<string>; skip: ReadonlySet<string>; paged: boolean };
type Choice = { kind: 'like' | 'hide' | 'undo'; vote: Vote | null } | { kind: 'avoid' | 'allow'; pair: string };
export type Pending = { key: string; kind: Choice['kind'] };
// `after` counts the reads started when the choice became unsettled; only a later read can settle it.
type Unresolved = { key: string; choice: Choice; after: number };

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

export type ConfirmedPairs = ReadonlyMap<string, { avoided: boolean; seq: number }>;
// As for votes: a pair avoided or allowed after a read started wins over that read.
export function mergePairs(snapshot: ReadonlySet<string>, confirmed: ConfirmedPairs, startSeq: number): Set<string> {
  const merged = new Set(snapshot);
  for (const [pair, entry] of confirmed) {
    if (entry.seq <= startSeq) continue;
    if (entry.avoided) merged.add(pair); else merged.delete(pair);
  }
  return merged;
}
// Ranking for a refreshed page: the fresh pairs, except pairs changed on this page keep the value the page was ranked with.
export function rankingPairs(fresh: ReadonlySet<string>, ranked: ReadonlySet<string>, changed: ReadonlySet<string>): Set<string> {
  const result = new Set(fresh);
  for (const pair of changed) if (ranked.has(pair)) result.add(pair); else result.delete(pair);
  return result;
}
// Ideas on the page holding a pair avoided since the page was drawn are left out, except the cards in `kept`: the card a pair
// was avoided on, which shows the choice and its Undo, and a card whose pair choice is still being written or settled.
export function visibleIdeas(suggestions: readonly Suggestion[], live: ReadonlySet<string>, ranked: ReadonlySet<string>,
  kept: { has(key: string): boolean }): Suggestion[] {
  const added = [...live].filter(pair => !ranked.has(pair)).map(pair => pair.split('|'));
  return suggestions.filter(suggestion => kept.has(suggestion.key)
    || !added.some(([low, high]) => suggestion.itemIds.includes(low!) && suggestion.itemIds.includes(high!)));
}

export type WeatherContext = Pick<EngineContext, 'setting' | 'temperatureC' | 'rainProbability' | 'windMetresPerSecond'>;

export function useSuggestions(client: AppClient, scope: OwnerScope, online: boolean, invalidation: number, occasion: Occasion, season: Season,
  weather: WeatherContext = {}) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<MessageKey | null>(null);
  const [tick, setTick] = useState(0);
  const [votes, setVotes] = useState<Map<string, Vote>>(() => new Map());
  const [run, setRun] = useState<Run>({ feedback: [], excluded: new Set(), skip: new Set(), paged: false });
  // Cards on this page where a pair was avoided, with that pair.
  const [chosen, setChosen] = useState<Map<string, string>>(() => new Map());
  const [pending, setPending] = useState<Pending | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [unresolved, setUnresolved] = useState<Unresolved | null>(null);
  // While a choice is being written or is unsettled the page keeps its ideas in place.
  const settling = pending !== null || unresolved !== null;
  // New weather (a forecast arriving, a manual temperature, staying in) redraws the ideas, but not while a choice is unsettled.
  const weatherId = JSON.stringify([weather.setting ?? null, weather.temperatureC ?? null, weather.rainProbability ?? null, weather.windMetresPerSecond ?? null]);
  const [applied, setApplied] = useState({ id: weatherId, weather });
  if (!settling && applied.id !== weatherId) setApplied({ id: weatherId, weather });
  const wasOnline = useRef(online);
  const votesRef = useRef(votes);
  const excludedRef = useRef<ReadonlySet<string>>(new Set());
  const writes = useRef<AbortController | null>(null);
  const seq = useRef(0);
  const reads = useRef(0);
  const unresolvedRef = useRef<Unresolved | null>(null);
  const confirmed = useRef(new Map<string, { vote: Vote | null; seq: number }>());
  const confirmedPairs = useRef(new Map<string, { avoided: boolean; seq: number }>());
  // Choices made on the page being shown keep their earlier ranking, so a hidden card stays in place with its Undo.
  const changedOnPage = useRef(new Set<string>());
  const changedPairs = useRef(new Set<string>());
  const newPage = useCallback(() => { changedOnPage.current = new Set(); changedPairs.current = new Set(); setChosen(new Map()); }, []);
  const reload = useCallback(() => setTick(value => value + 1), []);
  useEffect(() => { votesRef.current = votes; }, [votes]);
  useEffect(() => { unresolvedRef.current = unresolved; }, [unresolved]);
  useEffect(() => { excludedRef.current = data?.excluded ?? new Set(); }, [data]);
  useEffect(() => {
    if (online && !wasOnline.current) reload();
    wasOnline.current = online;
  }, [online, reload]);
  useEffect(() => {
    const controller = new AbortController();
    const startSeq = seq.current;
    const started = ++reads.current;
    setError(null);
    Promise.all([loadWardrobe(client, scope, controller.signal), loadSuggestionInputs(client, scope, controller.signal)]).then(([items, inputs]) => {
      if (controller.signal.aborted || scope.signal.aborted) return;
      const merged = mergeVotes(votesFrom(inputs.feedback), confirmed.current, startSeq);
      const pairs = mergePairs(new Set(inputs.excludedPairs.map(([low, high]) => pairKey(low, high))), confirmedPairs.current, startSeq);
      for (const [key, entry] of confirmed.current) if (entry.seq <= startSeq) confirmed.current.delete(key);
      for (const [pair, entry] of confirmedPairs.current) if (entry.seq <= startSeq) confirmedPairs.current.delete(pair);
      // An unsettled pair choice that this read (started after it) finds stored as chosen is done: its card shows the choice.
      const open = unresolvedRef.current;
      if (open && 'pair' in open.choice && started > open.after) {
        const key = open.key, choice = open.choice;
        const stored = inputs.excludedPairs.some(([low, high]) => pairKey(low, high) === choice.pair);
        if (stored === (choice.kind === 'avoid')) {
          setChosen(current => {
            const updated = new Map(current);
            if (stored) updated.set(key, choice.pair); else updated.delete(key);
            return updated;
          });
          unresolvedRef.current = null;
          setUnresolved(null);
        }
      }
      setData({ items, excluded: pairs });
      setVotes(merged);
      setRun(current => ({ ...current, feedback: feedbackFrom(rankingVotes(merged, votesFrom(current.feedback), changedOnPage.current)),
        excluded: rankingPairs(pairs, current.excluded, changedPairs.current) }));
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
  // A new occasion, season or weather starts again from the first ideas.
  useEffect(() => {
    newPage();
    setRun({ feedback: feedbackFrom(votesRef.current), excluded: excludedRef.current, skip: new Set(), paged: false });
    setFailed(null); setUnresolved(null);
  }, [occasion, season, applied.id, newPage]);

  const engineItems = useMemo(() => suggestionPool(data?.items ?? []), [data]);
  const result: SuggestionResult | null = useMemo(() => data ? recommend({
    items: engineItems, context: { ownerId: scope.ownerId, occasion, season, ...applied.weather },
    feedback: run.feedback, excludedPairs: [...run.excluded].map(pair => pair.split('|') as [string, string]), skip: run.skip,
  }) : null, [data, engineItems, scope.ownerId, occasion, season, applied, run]);

  const more = useCallback(() => {
    if (!result || settling) return;
    const shown = result.suggestions.map(suggestion => suggestion.coreKey);
    newPage();
    setRun(current => ({ feedback: feedbackFrom(votesRef.current), excluded: excludedRef.current, skip: new Set([...current.skip, ...shown]), paged: true }));
    setFailed(null); setUnresolved(null);
  }, [result, settling, newPage]);
  const startOver = useCallback(() => {
    if (settling) return;
    newPage();
    setRun({ feedback: feedbackFrom(votesRef.current), excluded: excludedRef.current, skip: new Set(), paged: false });
    setFailed(null); setUnresolved(null);
  }, [settling, newPage]);

  const write = useCallback(async (key: string, choice: Choice) => {
    const signal = writes.current?.signal;
    // One uncertain choice at a time: until it is settled only its own Try again may write.
    if (!signal || pending || !online || unresolved && unresolved.key !== key) return;
    setPending({ key, kind: choice.kind }); setFailed(null);
    setUnresolved(current => current?.key === key ? null : current);
    // A pending or unsettled card keeps its place through a refresh.
    changedOnPage.current.add(key);
    if ('pair' in choice) changedPairs.current.add(choice.pair);
    const owner = { ownerId: scope.ownerId, epoch: scope.epoch };
    const state: { outcome: WriteOutcome | null } = { outcome: null };
    // Sends the choice; a lost reply is checked against what was stored. True when the stored value is the choice.
    const settleWith = async <T,>(send: () => Promise<WriteOutcome>, read: () => Promise<T>, settle: (stored: T) => void, target: T) => {
      state.outcome = await send();
      if (state.outcome === 'done') { settle(target); return true; }
      if (state.outcome === 'unknown') {
        const stored = await read();
        settle(stored);
        return stored === target;
      }
      return false;
    };
    const settleVote = (stored: Vote | null) => {
      seq.current += 1;
      confirmed.current.set(key, { vote: stored, seq: seq.current });
      setVotes(current => {
        const updated = new Map(current);
        if (stored === null) updated.delete(key); else updated.set(key, stored);
        return updated;
      });
    };
    const settlePair = (pair: string) => (avoided: boolean) => {
      seq.current += 1;
      confirmedPairs.current.set(pair, { avoided, seq: seq.current });
      setData(current => {
        if (!current) return current;
        const excluded = new Set(current.excluded);
        if (avoided) excluded.add(pair); else excluded.delete(pair);
        return { ...current, excluded };
      });
      setChosen(current => {
        const updated = new Map(current);
        if (avoided) updated.set(key, pair); else updated.delete(key);
        return updated;
      });
    };
    try {
      const stored = 'pair' in choice
        ? await settleWith(() => writePair(client, scope, { ...owner, pair: choice.pair, avoid: choice.kind === 'avoid' }, signal),
          () => readPair(client, scope, { ...owner, pair: choice.pair, avoid: choice.kind === 'avoid' }, signal), settlePair(choice.pair), choice.kind === 'avoid')
        : await settleWith(() => writeVote(client, scope, { ...owner, key, choice: choice.vote }, signal),
          () => readVote(client, scope, { ...owner, key, choice: choice.vote }, signal), settleVote, choice.vote);
      if (!stored) setFailed(key);
    } catch (problem) {
      if (signal.aborted || isAborted(problem)) return;
      // The choice may have been stored; keep it so Try again can settle it.
      if (state.outcome === 'unknown') setUnresolved({ key, choice, after: reads.current }); else setFailed(key);
    } finally {
      if (!signal.aborted) setPending(null);
    }
  }, [client, scope, online, pending, unresolved]);

  const ideas = useMemo(() => {
    if (!result) return [];
    const kept = new Set(chosen.keys());
    if (pending && (pending.kind === 'avoid' || pending.kind === 'allow')) kept.add(pending.key);
    if (unresolved && 'pair' in unresolved.choice) kept.add(unresolved.key);
    return visibleIdeas(result.suggestions, data?.excluded ?? new Set(), run.excluded, kept);
  }, [result, data, run.excluded, chosen, pending, unresolved]);
  return {
    data, error, result, votes, pending, failed, unresolved: unresolved?.key ?? null, settling, paged: run.paged, reload, more, startOver,
    ideas, avoided: (key: string) => { const pair = chosen.get(key); return pair && data?.excluded.has(pair) ? pair : null; },
    // The pair of an uncertain Don't pair these or its Undo on this card, until it is settled.
    unsettledPair: (key: string) => unresolved?.key === key && 'pair' in unresolved.choice ? unresolved.choice.pair : null,
    retry: () => { if (unresolved) void write(unresolved.key, unresolved.choice); },
    hasClothes: Boolean(data?.items.some(item => item.lifecycle === 'active')),
    like: (key: string) => { void write(key, { kind: 'like', vote: votes.get(key) === 1 ? null : 1 }); },
    hide: (key: string) => { void write(key, { kind: 'hide', vote: -1 }); },
    undo: (key: string) => { void write(key, { kind: 'undo', vote: null }); },
    avoid: (key: string, first: string, second: string) => { if (first !== second) void write(key, { kind: 'avoid', pair: pairKey(first, second) }); },
    allow: (key: string) => { const pair = chosen.get(key); if (pair) void write(key, { kind: 'allow', pair }); },
  };
}
