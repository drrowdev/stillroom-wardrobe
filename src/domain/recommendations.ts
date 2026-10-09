import type { Category } from './wardrobe';
import type { Occasion } from './outfits';
import { pairScore } from './colour-pairs';

// Deterministic outfit rules (blueprint 09, ADR21). Pure: no clock, randomness, network, language or AI input.
export const rulesVersion = 'rules-v3';
export const seasonCodes = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof seasonCodes)[number];
export const formalityTargets: Readonly<Record<Occasion, number>> = { home: 0, everyday: 1, smart: 2, business: 3, formal: 4 };
// fitBand: how many points below the best remaining outfit an alternative may score and still be preferred for being less shown.
export const limits = { perCategory: 8, beam: 40, passBudget: 2000, suggestions: 3, fitBand: 10 } as const;

export type EngineItem = {
  id: string; ownerId: string; category: Category; colours: readonly string[]; seasons: readonly string[];
  formality: number | null; warmth: number | null; lowerCoverage: number | null;
  minTemp: number | null; maxTemp: number | null; rainRating: number | null; windproof: boolean | null;
  favourite: boolean; availability: string; lifecycle: string; excludeSuggestions: boolean; deleted: boolean;
};
export type EngineFeedback = { itemIds: readonly string[]; vote: 1 | -1 };
// Without weather input every weather rule is inactive and the result matches rules-v1. Indoors turns them all off.
export type EngineContext = {
  ownerId: string; occasion: Occasion; season: Season;
  setting?: 'indoors' | 'outdoors'; temperatureC?: number; rainProbability?: number; windMetresPerSecond?: number;
};
export type EngineInput = {
  items: readonly EngineItem[]; context: EngineContext;
  feedback?: readonly EngineFeedback[]; excludedPairs?: readonly (readonly [string, string])[];
  // Core keys already shown; used for "Show other ideas".
  skip?: ReadonlySet<string>;
};

export type ComponentId = 'W' | 'O' | 'C' | 'S' | 'N' | 'U' | 'F' | 'P';
export const weights: Readonly<Record<ComponentId, number>> = { W: 25, O: 20, C: 15, S: 10, N: 10, U: 10, F: 5, P: 5 };
export type Components = Partial<Record<ComponentId, number>>;
export type ReasonKey = 'warmth' | 'rainReady' | 'windReady' | 'season' | 'occasion' | 'colours' | 'favourite' | 'liked';
export type Reason = { key: ReasonKey; parameters: Readonly<Record<string, string>> };
export type MissingDetail = 'formality' | 'coverage' | 'rain' | 'wind';
export type WeatherNeed = 'cold' | 'rain' | 'wind';
// met: the outfit covers it; unknown: protection isn't recorded; lacking: no owned coat or layer is marked as protective;
// apart: one is, but not one that also covers the other needs; none: the owner has no coat (or layer, where one is enough).
export type WeatherNeedStatus = { need: WeatherNeed; status: 'met' | 'unknown' | 'lacking' | 'apart' | 'none' };
type WeatherClaims = { warmth: boolean; rain: boolean; wind: boolean };
export type Suggestion = {
  itemIds: string[]; key: string; coreKey: string; score: number; components: Components; reasons: Reason[];
  completeness: 'complete' | 'partial'; missingSlots: Category[]; missingDetails: MissingDetail[];
  // Present only while a cold, rain or wind rule applies.
  weatherNeeds?: WeatherNeedStatus[];
  rulesVersion: typeof rulesVersion; contextFingerprint: string;
};
export type SuggestionResult = {
  status: 'ideas' | 'partial' | 'empty' | 'none';
  suggestions: Suggestion[]; missingDetails: MissingDetail[]; expansions: number; passes: number;
};

const coreCategories: readonly Category[] = ['top', 'bottom', 'one_piece', 'footwear'];
const templates: readonly (readonly Category[])[] = [['top', 'bottom', 'footwear'], ['one_piece', 'footwear']];
const displayOrder: readonly Category[] = ['top', 'bottom', 'one_piece', 'layer', 'outerwear', 'footwear'];
const isCore = (item: EngineItem) => coreCategories.includes(item.category);
const isClothing = (item: EngineItem) => item.category !== 'footwear' && item.category !== 'accessory';
const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function combinationKey(ids: readonly string[]): string {
  return [...new Set(ids)].sort(compare).join('|');
}
// Same formula as private.feedback_signature(): SHA-256 of the sorted IDs joined by '|'.
export async function combinationSignature(ids: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(combinationKey(ids)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
export function seasonForDate(localDate: string): Season {
  const month = Number(localDate.slice(5, 7));
  return month >= 3 && month <= 5 ? 'spring' : month >= 6 && month <= 8 ? 'summer' : month >= 9 && month <= 11 ? 'autumn' : 'winter';
}
export function combineScore(components: Components): number {
  let numerator = 0, denominator = 0;
  for (const id of Object.keys(weights) as ComponentId[]) {
    const value = components[id];
    if (value === undefined) continue;
    numerator += weights[id] * value; denominator += weights[id];
  }
  return denominator ? 100 * numerator / denominator : 0;
}
export function warmthTarget(temperatureC: number): number {
  return temperatureC >= 25 ? 1 : temperatureC >= 18 ? 3 : temperatureC >= 10 ? 6 : temperatureC >= 2 ? 10 : 14;
}

export function eligible(item: EngineItem, context: EngineContext): boolean {
  if (item.ownerId !== context.ownerId || item.deleted || item.lifecycle !== 'active' || item.availability !== 'ready'
    || item.excludeSuggestions || item.category === 'accessory') return false;
  const t = context.temperatureC;
  if (context.setting === 'outdoors' && t !== undefined
    && (item.minTemp !== null && t < item.minTemp || item.maxTemp !== null && t > item.maxTemp)) return false;
  return true;
}

function warmthFit(pieces: readonly EngineItem[], context: EngineContext): number | undefined {
  const clothing = pieces.filter(isClothing);
  if (context.setting !== 'outdoors' || context.temperatureC === undefined || !clothing.length || clothing.some(item => item.warmth === null)) return undefined;
  const sum = clothing.reduce((total, item) => total + item.warmth! * (item.category === 'one_piece' || item.category === 'outerwear' ? 2 : 1), 0);
  return Math.max(0, 1 - Math.abs(sum - warmthTarget(context.temperatureC)) / 6);
}

export function componentsFor(pieces: readonly EngineItem[], context: EngineContext, liked: ReadonlySet<string>): Components {
  const result: Components = {};
  const clothing = pieces.filter(isClothing);
  const seasonMatch = clothing.length ? clothing.filter(item => item.seasons.includes(context.season)).length / clothing.length : undefined;
  const warmth = warmthFit(pieces, context);
  if (warmth !== undefined) result.W = warmth * 0.9 + (seasonMatch ?? 0) * 0.1;
  else if (seasonMatch !== undefined) result.W = seasonMatch;
  const target = formalityTargets[context.occasion];
  const known = pieces.filter(item => isCore(item) && item.formality !== null);
  if (known.length) result.O = mean(known.map(item => Math.max(0, 1 - Math.abs(item.formality! - target) / 2)));
  if (clothing.length >= 2) {
    const scores: number[] = [];
    for (let i = 0; i < clothing.length; i++) for (let j = i + 1; j < clothing.length; j++) {
      scores.push(pairScore(clothing[i]!.colours[0] ?? 'unknown', clothing[j]!.colours[0] ?? 'unknown'));
    }
    result.C = mean(scores);
  }
  if (pieces.length) {
    result.F = pieces.filter(item => item.favourite).length / pieces.length;
    result.P = liked.has(combinationKey(pieces.map(item => item.id))) ? 0.75 : 0.5;
  }
  return result;
}

function reasonsFor(components: Components, pieces: readonly EngineItem[], context: EngineContext, liked: boolean, weather: WeatherClaims): Reason[] {
  const candidates: { weight: number; reason: Reason }[] = [];
  // Weather reasons come first, and only for a requirement the outfit is known to meet.
  if (weather.warmth) candidates.push({ weight: 100, reason: { key: 'warmth', parameters: {} } });
  if (weather.rain) candidates.push({ weight: 100, reason: { key: 'rainReady', parameters: {} } });
  if (weather.wind) candidates.push({ weight: 100, reason: { key: 'windReady', parameters: {} } });
  const add = (id: ComponentId, ok: boolean, reason: Reason) => {
    if (ok && components[id] !== undefined) candidates.push({ weight: weights[id] * components[id]!, reason });
  };
  add('W', components.W === 1, { key: 'season', parameters: { season: context.season } });
  add('O', (components.O ?? 0) >= 0.75, { key: 'occasion', parameters: { occasion: context.occasion } });
  add('C', (components.C ?? 0) >= 0.85, { key: 'colours', parameters: {} });
  add('P', liked, { key: 'liked', parameters: {} });
  add('F', pieces.some(item => item.favourite), { key: 'favourite', parameters: {} });
  // Stable sort keeps the listed order on equal contributions.
  return candidates.sort((a, b) => b.weight - a.weight).slice(0, 2).map(candidate => candidate.reason);
}

type State = { pieces: EngineItem[]; score: number; key: string };
const byRank = (a: State, b: State) => b.score - a.score || compare(a.key, b.key);
const coreIds = (pieces: readonly EngineItem[]) => pieces.filter(isCore).map(item => item.id);
const lowerOnly = (item: EngineItem) => item.category === 'bottom' || item.category === 'one_piece';

function itemRank(context: EngineContext) {
  const target = formalityTargets[context.occasion];
  const fit = (item: EngineItem) => (item.seasons.includes(context.season) ? 1 : 0)
    + (item.formality === null ? 0.5 : Math.max(0, 1 - Math.abs(item.formality - target) / 2)) + (item.favourite ? 0.5 : 0);
  return (a: EngineItem, b: EngineItem) => fit(b) - fit(a) || compare(a.id, b.id);
}

type Cover = { categories: Category[]; accepts: (item: EngineItem) => boolean };
type CoverRequirement = { cover: Cover | null; unmet: MissingDetail[]; cold: boolean; required: boolean; needs: WeatherNeedStatus[] };
function coverRequirement(context: EngineContext, buckets: ReadonlyMap<Category, EngineItem[]>): CoverRequirement {
  if (context.setting !== 'outdoors') return { cover: null, unmet: [], cold: false, required: false, needs: [] };
  const cold = context.temperatureC !== undefined && context.temperatureC <= 5;
  const rain = context.rainProbability !== undefined && context.rainProbability >= 60;
  const wind = context.windMetresPerSecond !== undefined && context.windMetresPerSecond >= 10;
  if (!cold && !rain && !wind) return { cover: null, unmet: [], cold, required: false, needs: [] };
  const active = ([['cold', cold], ['rain', rain], ['wind', wind]] as const).filter(([, on]) => on).map(([need]) => need);
  const categories: Category[] = cold ? ['outerwear'] : ['layer', 'outerwear'];
  const accepts = (item: EngineItem) => (!rain || (item.rainRating ?? 0) >= 1) && (!wind || item.windproof === true);
  const pool = categories.flatMap(category => buckets.get(category) ?? []);
  if (pool.some(accepts)) return { cover: { categories, accepts }, unmet: [], cold, required: true, needs: active.map(need => ({ need, status: 'met' })) };
  const unmet: MissingDetail[] = [];
  if (rain && pool.some(item => item.rainRating === null)) unmet.push('rain');
  if (wind && pool.some(item => item.windproof === null)) unmet.push('wind');
  // Without a suitable cover the outfit meets none of these; each status says why, without guessing at unknown protection.
  const status = (need: WeatherNeed): WeatherNeedStatus['status'] => {
    if (!pool.length) return 'none';
    if (need === 'cold') return 'lacking';
    if (unmet.includes(need)) return 'unknown';
    return pool.some(item => need === 'rain' ? (item.rainRating ?? 0) >= 1 : item.windproof === true) ? 'apart' : 'lacking';
  };
  return { cover: null, unmet, cold, required: true, needs: active.map(need => ({ need, status: status(need) })) };
}

type Step = { categories: Category[]; optional: boolean; accepts?: (item: EngineItem) => boolean };
// `core` rejects a finished core outright (already shown, dress code); `allowed` rejects an exact disliked combination.
type Filters = { core: (state: State) => boolean; allowed: (state: State) => boolean };

function difference(a: readonly string[], b: readonly string[]): number {
  return Math.max(a.filter(id => !b.includes(id)).length, b.filter(id => !a.includes(id)).length);
}

// How often each garment appeared in the cores already shown (the skipped keys of Show another).
function exposureOf(skip: ReadonlySet<string>): Map<string, number> {
  const items = new Map<string, number>();
  for (const key of skip) for (const id of key.split('|')) items.set(id, (items.get(id) ?? 0) + 1);
  return items;
}

// How many shown cores this search could still reach below each unfinished prefix of the template. Only a shown core that fits
// the template and its capped candidate window counts, so garments that are gone or outside the window never hide unseen ones.
function shownBelow(template: readonly Category[], buckets: ReadonlyMap<Category, EngineItem[]>, cap: number, skip: ReadonlySet<string>) {
  const slot = new Map<string, number>();
  template.forEach((category, index) => (buckets.get(category) ?? []).slice(0, cap).forEach(item => slot.set(item.id, index)));
  const counts = new Map<string, number>();
  for (const key of skip) {
    const ids = key.split('|');
    const slots = ids.map(id => slot.get(id));
    if (ids.length !== template.length || slots.some(index => index === undefined) || new Set(slots).size !== template.length) continue;
    const ordered = ids.sort((a, b) => slot.get(a)! - slot.get(b)!);
    for (let size = 1; size < template.length; size++) {
      const prefix = combinationKey(ordered.slice(0, size));
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  return counts;
}

// Chooses up to limit distinct cores from a rank-sorted list. Each pick is the least-shown core (mean garment exposure, from
// history plus the earlier picks) among those scoring within limits.fitBand of the best one left; ties go to the core that
// differs most from the picks, then to rank. With no history the best-scoring core therefore comes first. With fill, other
// states of an already chosen core follow in rank order until limit. Scores are never changed; this only picks and orders.
function diversify<T extends { score: number }>(ranked: readonly T[], coreOf: (item: T) => readonly string[],
  history: ReadonlyMap<string, number>, limit: number, fill: boolean): T[] {
  // A fill list that already fits keeps everything, and the caller sorts it again.
  if (fill && ranked.length <= limit) return [...ranked];
  // gap: fewest garments by which the core differs from any core picked so far.
  type Entry = { item: T; core: readonly string[]; gap: number };
  const seen = new Set<string>();
  const pending: Entry[] = [], rest: T[] = [];
  for (const item of ranked) {
    const core = coreOf(item), key = combinationKey(core);
    if (seen.has(key)) rest.push(item); else { seen.add(key); pending.push({ item, core, gap: Infinity }); }
  }
  const exposure = new Map(history);
  const load = (core: readonly string[]) => core.reduce((sum, id) => sum + (exposure.get(id) ?? 0), 0);
  const picked: Entry[] = [];
  while (picked.length < limit && pending.length) {
    const best = pending[0]!.item.score;
    let choice = 0, choiceLoad = load(pending[0]!.core);
    for (let index = 1; index < pending.length && best - pending[index]!.item.score <= limits.fitBand; index++) {
      const entry = pending[index]!, entryLoad = load(entry.core);
      // Compares mean exposure entryLoad/size with choiceLoad/size without division.
      const order = entryLoad * pending[choice]!.core.length - choiceLoad * entry.core.length;
      if (order < 0 || order === 0 && entry.gap > pending[choice]!.gap) { choice = index; choiceLoad = entryLoad; }
    }
    const [entry] = pending.splice(choice, 1);
    picked.push(entry!);
    for (const id of entry!.core) exposure.set(id, (exposure.get(id) ?? 0) + 1);
    for (const other of pending) other.gap = Math.min(other.gap, difference(other.core, entry!.core));
  }
  return fill ? [...picked.map(entry => entry.item), ...rest].slice(0, limit) : picked.map(entry => entry.item);
}

// Once the core is complete, acceptable states and disliked cores live in two separately capped beams. Disliked cores are
// only seeds for added pieces, so they never take a slot from an acceptable state, and only acceptable states are returned.
function search(template: readonly Category[], extra: readonly Step[], buckets: ReadonlyMap<Category, EngineItem[]>, cap: number,
  score: (pieces: EngineItem[]) => number, excluded: ReadonlySet<string>, budget: { left: number }, filters: Filters,
  history: ReadonlyMap<string, number>, skip: ReadonlySet<string>): State[] {
  const steps: Step[] = [...template.map(category => ({ categories: [category], optional: false })), ...extra];
  const shownWith = shownBelow(template, buckets, cap, skip);
  let beam: State[] = [{ pieces: [], score: 0, key: '' }];
  let seeds: State[] = [];
  for (const [index, step] of steps.entries()) {
    const next: State[] = [], nextSeeds: State[] = [];
    const expand = (state: State, own: State[]) => {
      if (step.optional) own.push(state);
      for (const category of step.categories) {
        for (const item of (buckets.get(category) ?? []).slice(0, cap)) {
          if (budget.left <= 0) break;
          budget.left--;
          if (step.accepts && !step.accepts(item)) continue;
          if (state.pieces.some(piece => piece.id === item.id || excluded.has(pairKey(piece.id, item.id)))) continue;
          const pieces = [...state.pieces, item];
          const value = score(pieces);
          // An optional piece stays only when it strictly improves the outfit.
          if (step.optional && value <= state.score) continue;
          const extended = { pieces, score: value, key: combinationKey(pieces.map(piece => piece.id)) };
          (index < template.length - 1 || filters.allowed(extended) ? next : nextSeeds).push(extended);
        }
      }
    };
    for (const state of beam) expand(state, next);
    for (const state of seeds) expand(state, nextSeeds);
    const coreDone = index === template.length - 1;
    // An unfinished core whose every completion was already shown only takes a slot from ones that still have something to show.
    const room = template.slice(index + 1).reduce((total, category) => total * Math.min(buckets.get(category)?.length ?? 0, cap), 1);
    const open = coreDone ? next.filter(filters.core) : next.filter(state => (shownWith.get(combinationKey(coreIds(state.pieces))) ?? 0) < room);
    beam = diversify(open.sort(byRank), state => coreIds(state.pieces), history, limits.beam, true).sort(byRank);
    seeds = (coreDone ? nextSeeds.filter(filters.core) : nextSeeds).sort(byRank).slice(0, limits.beam);
    if (!beam.length && !seeds.length) return [];
  }
  return beam.filter(state => template.every(category => state.pieces.some(piece => piece.category === category)));
}

function formalityGate(pieces: readonly EngineItem[], target: number): boolean {
  const values = pieces.filter(isCore).map(item => item.formality);
  if (values.some(value => value === null || value < target - 1)) return false;
  const sorted = (values as number[]).sort((a, b) => a - b);
  const middle = sorted.length / 2;
  const median = sorted.length % 2 ? sorted[Math.floor(middle)]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return median >= target;
}


export function recommend(input: EngineInput): SuggestionResult {
  const { context } = input;
  const fingerprint = [context.occasion, context.season, context.setting ?? '-', context.temperatureC ?? '-',
    context.rainProbability ?? '-', context.windMetresPerSecond ?? '-', rulesVersion].join('|');
  const pool = input.items.filter(item => eligible(item, context));
  const ids = new Set(pool.map(item => item.id));
  const disliked = new Set<string>(), liked = new Set<string>();
  for (const vote of input.feedback ?? []) {
    if (!vote.itemIds.every(id => ids.has(id))) continue;
    (vote.vote < 0 ? disliked : liked).add(combinationKey(vote.itemIds));
  }
  const excluded = new Set((input.excludedPairs ?? []).map(([a, b]) => pairKey(a, b)));
  const rank = itemRank(context);
  const bucketsFor = (items: readonly EngineItem[]) => {
    const map = new Map<Category, EngineItem[]>();
    for (const item of items) map.set(item.category, [...map.get(item.category) ?? [], item]);
    for (const list of map.values()) list.sort(rank);
    return map;
  };
  const all = bucketsFor(pool);
  const base = { expansions: 0, passes: 0 };
  if (!pool.length) return { status: 'empty', suggestions: [], missingDetails: [], ...base };

  const make = (pieces: EngineItem[], extra: Pick<Suggestion, 'completeness' | 'missingSlots' | 'missingDetails' | 'weatherNeeds'>): Suggestion => {
    const ordered = [...pieces].sort((a, b) => displayOrder.indexOf(a.category) - displayOrder.indexOf(b.category));
    const key = combinationKey(ordered.map(item => item.id));
    const components = componentsFor(ordered, context, liked);
    const complete = extra.completeness === 'complete';
    const met = (need: WeatherNeed) => complete && Boolean(extra.weatherNeeds?.some(entry => entry.need === need && entry.status === 'met'));
    const claims = { warmth: complete && (warmthFit(ordered, context) ?? 0) >= 0.8, rain: met('rain'), wind: met('wind') };
    return {
      itemIds: ordered.map(item => item.id), key, coreKey: combinationKey(coreIds(ordered)), score: combineScore(components), components,
      reasons: reasonsFor(components, ordered, context, liked.has(key), claims), rulesVersion, contextFingerprint: fingerprint, ...extra,
    };
  };

  const score = (pieces: EngineItem[]) => combineScore(componentsFor(pieces, context, liked));
  const skip = input.skip ?? new Set<string>();
  const unshown = (state: State) => !skip.has(combinationKey(coreIds(state.pieces)));
  const notDisliked = (state: State) => !disliked.has(state.key);

  const fillable = templates.filter(template => template.every(category => all.get(category)?.length));
  if (!fillable.length) {
    // The weather rules apply to an unfinished outfit too: bottoms known to be short are left out in the cold, a suitable
    // cover is added when there is one, and every unmet weather need is reported.
    const partialCold = coverRequirement(context, all).cold;
    const usable = partialCold ? bucketsFor(pool.filter(item => !lowerOnly(item) || item.lowerCoverage === null || item.lowerCoverage >= 2)) : all;
    const { cover, unmet, needs } = coverRequirement(context, usable);
    const best = [...templates].sort((a, b) => b.filter(c => usable.get(c)?.length).length - a.filter(c => usable.get(c)?.length).length)[0]!;
    const present = best.filter(category => usable.get(category)?.length);
    if (!present.length) return { status: 'empty', suggestions: [], missingDetails: [], ...base };
    const extra: Step[] = cover ? [{ categories: cover.categories, optional: false, accepts: cover.accepts }] : [];
    let found: State | undefined;
    let expansions = 0, passes = 0;
    const history = exposureOf(skip);
    for (const cap of [limits.perCategory, limits.perCategory * 2]) {
      if (passes && ![...present, ...cover?.categories ?? []].some(category => (usable.get(category)?.length ?? 0) > limits.perCategory)) break;
      passes++;
      const budget = { left: limits.passBudget };
      const states = search(present, extra, usable, cap, score, excluded, budget, { core: unshown, allowed: notDisliked }, history, skip);
      [found] = diversify(states, state => coreIds(state.pieces), history, 1, false);
      expansions += limits.passBudget - budget.left;
      if (found) break;
    }
    if (!found) return { status: 'none', suggestions: [], missingDetails: [...unmet], expansions, passes };
    const missingSlots = best.filter(category => !present.includes(category));
    const lower = found.pieces.filter(lowerOnly).map(item => item.lowerCoverage);
    const details: MissingDetail[] = [...unmet, ...partialCold && lower.length && !lower.includes(2) ? ['coverage' as const] : []];
    const suggestion = make(found.pieces, { completeness: 'partial', missingSlots, missingDetails: details, ...needs.length && { weatherNeeds: needs } });
    return { status: 'partial', suggestions: [suggestion], missingDetails: details, expansions, passes };
  }

  const target = formalityTargets[context.occasion];
  const strict = target >= 3;
  const missingDetails: MissingDetail[] = [];
  if (strict && pool.some(item => isCore(item) && item.formality === null)) missingDetails.push('formality');
  const buckets = strict ? bucketsFor(pool.filter(item => !isCore(item) || item.formality !== null && item.formality >= target - 1)) : all;
  const { cover, unmet, cold, required, needs } = coverRequirement(context, buckets);
  for (const detail of unmet) if (!missingDetails.includes(detail)) missingDetails.push(detail);
  const extra: Step[] = cover ? [{ categories: cover.categories, optional: false, accepts: cover.accepts }] : [];
  if (cover && cold) extra.push({ categories: ['layer'], optional: true });
  if (!cover && (context.season === 'autumn' || context.season === 'winter' || context.setting === 'outdoors' && context.temperatureC !== undefined)) {
    extra.push({ categories: ['layer'], optional: true }, { categories: ['outerwear'], optional: true });
  }
  let valid: Suggestion[] = [];
  let expansions = 0, passes = 0;
  const history = exposureOf(skip);
  const filters: Filters = { core: state => unshown(state) && (!strict || formalityGate(state.pieces, target)), allowed: notDisliked };
  for (const cap of [limits.perCategory, limits.perCategory * 2]) {
    if (passes && ![...buckets.values()].some(list => list.length > limits.perCategory)) break;
    passes++;
    const budget = { left: limits.passBudget };
    const states = templates.flatMap(template => search(template, extra, buckets, cap, score, excluded, budget, filters, history, skip));
    expansions += limits.passBudget - budget.left;
    const seen = new Set<string>();
    valid = [];
    for (const state of states) {
      if (seen.has(state.key) || disliked.has(state.key)) continue;
      seen.add(state.key);
      if (strict && !formalityGate(state.pieces, target)) continue;
      const details: MissingDetail[] = [];
      if (cold) {
        const lower = state.pieces.filter(item => item.category === 'bottom' || item.category === 'one_piece').map(item => item.lowerCoverage);
        if (lower.some(value => value === 2)) { /* ankle coverage met */ } else if (lower.every(value => value !== null)) continue;
        else details.push('coverage');
      }
      const missingSlots: Category[] = required && !cover ? ['outerwear'] : [];
      const suggestion = make(state.pieces, { completeness: details.length || missingSlots.length ? 'partial' : 'complete', missingSlots,
        missingDetails: [...unmet, ...details], ...needs.length && { weatherNeeds: needs } });
      if (skip.has(suggestion.coreKey)) continue;
      valid.push(suggestion);
    }
    if (valid.length) break;
  }
  valid.sort((a, b) => b.score - a.score || compare(a.key, b.key));
  const chosen = diversify(valid, suggestion => suggestion.coreKey.split('|'), history, limits.suggestions, false);
  chosen.sort((a, b) => b.score - a.score || compare(a.key, b.key));
  for (const suggestion of chosen) for (const detail of suggestion.missingDetails) if (!missingDetails.includes(detail)) missingDetails.push(detail);
  return { status: chosen.length ? 'ideas' : 'none', suggestions: chosen, missingDetails, expansions, passes };
}
