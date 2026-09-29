export type ApiResponse = { status: number; body: unknown };
export type Api = (resource: string) => ApiResponse;
export type Git = (args: string[]) => string;
export interface Options { sha: string; ciRun: number; appleRun: number; disclosure?: string }
export interface Outcome { verdict: 'PASS' | 'FAIL' | 'BLOCKED'; reasons: string[]; lines: string[] }
export const REPOSITORY: string;
export const WORKFLOWS: { ci: { file: string; path: string }; apple: { file: string; path: string } };
export const CI_JOBS: string[];
export const APPLE_JOBS: string[];
export const EXPECTED_SKIPPED: { ci: string[]; apple: string[] };
export const PINNED: { ci: string[]; apple: string[] };
export const A11Y_LINE: string;
export const R1_REMINDER: string;
export class Blocked extends Error {}
export function jobNames(text: string): string[];
export function paginate(get: (page: number) => ApiResponse | undefined, key: string, perPage?: number): unknown[];
export function gather(options: Options, deps: { api: Api; git: Git; now?: () => string }): unknown;
export function evaluate(snapshot: unknown): Outcome;
export function exitCode(verdict: string): number;
export function parseArguments(argv: string[]): { options?: Options; error?: string };
