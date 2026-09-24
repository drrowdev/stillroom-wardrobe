import { colours } from './preferences';

export type Colour = (typeof colours)[number];
export const neutralColours: ReadonlySet<Colour> = new Set(['black', 'white', 'cream', 'grey', 'navy', 'beige', 'khaki', 'brown']);
const adjacentPairs: readonly (readonly [Colour, Colour])[] = [
  ['blue', 'light_blue'], ['blue', 'teal'], ['light_blue', 'teal'], ['teal', 'green'], ['green', 'olive'],
  ['red', 'burgundy'], ['burgundy', 'purple'], ['red', 'orange'], ['orange', 'yellow'], ['pink', 'purple'], ['gold', 'yellow'],
];
const adjacent = new Set(adjacentPairs.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));

export function isColour(value: unknown): value is Colour {
  return typeof value === 'string' && colours.some(code => code === value);
}

// PROPOSED heuristic from blueprint 09; nothing here bans a colour.
export function pairScore(a: string, b: string): number {
  if (!isColour(a) || !isColour(b)) return 0.5;
  if (neutralColours.has(a) || neutralColours.has(b)) return 1;
  if (a === b) return 0.8;
  return adjacent.has(`${a}|${b}`) ? 0.85 : 0.6;
}
