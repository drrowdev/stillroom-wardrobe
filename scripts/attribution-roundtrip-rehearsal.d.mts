export const ROUNDTRIP_BOUND_MS: number;
export function registerFixtureLoader(): void;
export function cliEnvironment(source: Record<string, string | undefined>, key: string): Record<string, string>;
export function terminal(answers: string[]): {
  stdin: import('node:stream').PassThrough & { isTTY: true; setRawMode: () => unknown };
  stderr: { write: (text: string) => boolean };
  text: () => string;
  left: () => number;
};
export function expectedImported<T extends { source_image_id: string | null }>(entries: T[], photos: Map<string, string>):
  (T & { origin: 'imported' })[];
export function differing(actual: unknown, expected: Record<string, unknown>[], copies: Set<string>): string;
export function failureCode(error: unknown): string;
