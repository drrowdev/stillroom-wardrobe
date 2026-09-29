export const BENCH_ROOT: string;
export const LIFETIME_MS: number;
export const RUNS: number;
export const LIMIT_MS: number;
export const DEFAULT_PORT: number;
export const FORBIDDEN: string[];
export interface Fixture { seed: number; items: number; contexts: number; runs: number }
export function isPrivateIPv4(address: unknown): boolean;
export function parseBenchArguments(argv: string[]): { options?: { candidate: string; lan?: string; port: number; host: string }; error?: string };
export function checkBinding(candidate: string, git: (args: string[]) => string): string | null;
export function buildEngineScript(outDir?: string): Promise<string>;
export function fixtureOf(engineScript: string): Fixture;
export function renderPage(input: { sha: string; engineScript: string; fixture: Fixture }): { html: string; headers: string };
export function serveBench(input: { root: string; host: string; port: number; lifetimeMs?: number }): Promise<{ url: string; close: () => Promise<void>; closed: Promise<void>; stopsAt: Date }>;
export function main(argv: string[], deps?: {
  git?: (args: string[]) => string;
  build?: () => Promise<string>;
  serve?: (input: { root: string; host: string; port: number }) => Promise<{ url: string; closed: Promise<void>; stopsAt: Date }>;
  log?: (line: string) => void;
  root?: string;
}): Promise<number>;
