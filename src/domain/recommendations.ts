import type { Category } from './wardrobe';
import type { Occasion } from './outfits';
import { pairScore } from './colour-pairs';

// Deterministic outfit rules (blueprint 09, ADR21). Pure: no clock, randomness, network, language or AI input.
export const rulesVersion = 'rules-v1';
export const seasonCodes = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof seasonCodes)[number];
export const formalityTargets: Readonly<Record<Occasion, number>> = { home: 0, everyday: 1, smart: 2, business: 3, formal: 4 };
export const limits = { perCategory: 8, beam: 40, passBudget: 2000, suggestions: 3 } as const;

export type EngineItem = {
  id: string; ownerId: string; category: Category; colours: readonly string[]; seasons: readonly string[];
  formality: number | null; warmth: number | null; lowerCoverage: number | null;
  minTemp: number | null; maxTemp: number | null; rainRating: number | null; windproof: boolean | null;
  favourite: boolean; availability: string; lifecycle: string; excludeSuggestions: boolean; deleted: boolean;
};
export type EngineFeedback = { itemIds: readonly string[]; vote: 1 | -1 };
// Weather fields are for Phase 5; without them every weather rule is inactive.
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
export type ReasonKey = 'season' | 'occasion' | 'colours' | 'favourite' | 'liked';
export type Reason = { key: ReasonKey; parameters: Readonly<Record<string, string>> };
export type MissingDetail = 'formality' | 'coverage' | 'rain' | 'wind';
export type Suggestion = {
  itemIds: string[]; key: string; coreKey: string; score: number; components: Components; reasons: Reason[];
  completeness: 'complete' | 'partial'; missingSlots: Category[]; missingDetails: MissingDetail[];
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
  if (context.temperatureC === undefined || !clothing.length || clothing.some(item => item.warmth === null)) return undefined;
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

function reasonsFor(components: Components, pieces: readonly EngineItem[], context: EngineContext, liked: boolean): Reason[] {
  const candidates: { weight: number; reason: Reason }[] = [];
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

function itemRank(context: EngineContext) {
  const target = formalityTargets[context.occasion];
  const fit = (item: EngineItem) => (item.seasons.includes(context.season) ? 1 : 0)
    + (item.formality === null ? 0.5 : Math.max(0, 1 - Math.abs(item.formality - target) / 2)) + (item.favourite ? 0.5 : 0);
  return (a: EngineItem, b: EngineItem) => fit(b) - fit(a) || compare(a.id, b.id);
}

type Cover = { categories: Category[]; accepts: (item: EngineItem) => boolean };
function coverRequirement(context: EngineContext, buckets: ReadonlyMap<Category, EngineItem[]>): { cover: Cover | null; unmet: MissingDetail[]; cold: boolean; required: boolean } {
  if (context.setting !== 'outdoors') return { cover: null, unmet: [], cold: false, required: false };
  const cold = context.temperatureC !== undefined && context.temperatureC <= 5;
  const rain = context.rainProbability !== undefined && context.rainProbability >= 60;
  const wind = context.windMetresPerSecond !== undefined && context.windMetresPerSecond >= 10;
  if (!cold && !rain && !wind) return { cover: null, unmet: [], cold, required: false };
  const categories: Category[] = cold ? ['outerwear'] : ['layer', 'outerwear'];
  const accepts = (item: EngineItem) => (!rain || (item.rainRating ?? 0) >= 1) && (!wind || item.windproof === true);
  const pool = categories.flatMap(category => buckets.get(category) ?? []);
  if (pool.some(accepts)) return { cover: { categories, accepts }, unmet: [], cold, required: true };
  const unmet: MissingDetail[] = [];
  if (rain && pool.some(item => item.rainRating === null)) unmet.push('rain');
  if (wind && pool.some(item => item.windproof === null)) unmet.push('wind');
  return { cover: null, unmet, cold, required: true };
}

type Step = { categories: Category[]; optional: boolean; accepts?: (item: EngineItem) => boolean };

function search(template: readonly Category[], extra: readonly Step[], buckets: ReadonlyMap<Category, EngineItem[]>, cap: number,
  score: (pieces: EngineItem[]) => number, excluded: ReadonlySet<string>, budget: { left: number }): State[] {
  const steps: Step[] = [...template.map(category => ({ categories: [category], optional: false })), ...extra];
  let beam: State[] = [{ pieces: [], score: 0, key: '' }];
  for (const step of steps) {
    const next: State[] = [];
    for (const state of beam) {
      if (step.optional) next.push(state);
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
          next.push({ pieces, score: value, key: combinationKey(pieces.map(piece => piece.id)) });
        }
      }
    }
    beam = next.sort(byRank).slice(0, limits.beam);
    if (!beam.length) return [];
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

function difference(a: readonly string[], b: readonly string[]): number {
  return Math.max(a.filter(id => !b.includes(id)).length, b.filter(id => !a.includes(id)).length);
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

  const make = (pieces: EngineItem[], extra: Pick<Suggestion, 'completeness' | 'missingSlots' | 'missingDetails'>): Suggestion => {
    const ordered = [...pieces].sort((a, b) => displayOrder.indexOf(a.category) - displayOrder.indexOf(b.category));
    const key = combinationKey(ordered.map(item => item.id));
    const components = componentsFor(ordered, context, liked);
    return {
      itemIds: ordered.map(item => item.id), key, coreKey: combinationKey(coreIds(ordered)), score: combineScore(components), components,
      reasons: reasonsFor(components, ordered, context, liked.has(key)), rulesVersion, contextFingerprint: fingerprint, ...extra,
    };
  };

  const fillable = templates.filter(template => template.every(category => all.get(category)?.length));
  if (!fillable.length) {
    const best = [...templates].sort((a, b) => b.filter(c => all.get(c)?.length).length - a.filter(c => all.get(c)?.length).length)[0]!;
    const pieces: EngineItem[] = [];
    for (const category of best) {
      const item = all.get(category)?.find(candidate => pieces.every(piece => !excluded.has(pairKey(piece.id, candidate.id))));
      if (item) pieces.push(item);
    }
    if (!pieces.length) return { status: 'empty', suggestions: [], missingDetails: [], ...base };
    const missingSlots = best.filter(category => !pieces.some(piece => piece.category === category));
    return { status: 'partial', suggestions: [make(pieces, { completeness: 'partial', missingSlots, missingDetails: [] })], missingDetails: [], ...base };
  }

  const target = formalityTargets[context.occasion];
  const strict = target >= 3;
  const missingDetails: MissingDetail[] = [];
  if (strict && pool.some(item => isCore(item) && item.formality === null)) missingDetails.push('formality');
  const buckets = strict ? bucketsFor(pool.filter(item => !isCore(item) || item.formality !== null && item.formality >= target - 1)) : all;
  const { cover, unmet, cold, required } = coverRequirement(context, buckets);
  for (const detail of unmet) if (!missingDetails.includes(detail)) missingDetails.push(detail);
  const extra: Step[] = cover ? [{ categories: cover.categories, optional: false, accepts: cover.accepts }] : [];
  if (cover && cold) extra.push({ categories: ['layer'], optional: true });
  if (!cover && (context.season === 'autumn' || context.season === 'winter' || context.temperatureC !== undefined)) {
    extra.push({ categories: ['layer'], optional: true }, { categories: ['outerwear'], optional: true });
  }
  const score = (pieces: EngineItem[]) => combineScore(componentsFor(pieces, context, liked));
  const skip = input.skip ?? new Set<string>();
  let valid: Suggestion[] = [];
  let expansions = 0, passes = 0;
  for (const cap of [limits.perCategory, limits.perCategory * 2]) {
    if (passes && ![...buckets.values()].some(list => list.length > limits.perCategory)) break;
    passes++;
    const budget = { left: limits.passBudget };
    const states = templates.flatMap(template => search(template, extra, buckets, cap, score, excluded, budget));
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
      const suggestion = make(state.pieces, { completeness: details.length || missingSlots.length ? 'partial' : 'complete', missingSlots, missingDetails: [...unmet, ...details] });
      if (skip.has(suggestion.coreKey)) continue;
      valid.push(suggestion);
    }
    if (valid.length) break;
  }
  valid.sort((a, b) => b.score - a.score || compare(a.key, b.key));
  const chosen: Suggestion[] = [];
  for (const need of [2, 1]) {
    for (const candidate of valid) {
      if (chosen.length >= limits.suggestions) break;
      if (chosen.includes(candidate)) continue;
      const core = candidate.coreKey.split('|');
      if (chosen.every(other => difference(core, other.coreKey.split('|')) >= need)) chosen.push(candidate);
    }
  }
  chosen.sort((a, b) => b.score - a.score || compare(a.key, b.key));
  for (const suggestion of chosen) for (const detail of suggestion.missingDetails) if (!missingDetails.includes(detail)) missingDetails.push(detail);
  return { status: chosen.length ? 'ideas' : 'none', suggestions: chosen, missingDetails, expansions, passes };
}
