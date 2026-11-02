// Types for the pure parts that tests/unit/manifest-eligibility.test.ts pins against the migrations.
export const ELIGIBILITY_LABEL: string;
export const ELIGIBLE_UNTIL: string;
export const MANIFEST_DATES: Readonly<Record<string, string>>;
export const SNAPSHOT_SQL: string;
export const IMMUTABLE_SQL: string;
export const PROBES: Readonly<Record<string, Readonly<{ id: string; setup: (uid: string) => string; call: (uid: string) => string }>>>;
export function moveSql(direction: 'advance' | 'restore', dates?: Readonly<Record<string, string>>): string;
export function createManifestEligibility(sql: (text: string) => Promise<string>, options?: {
  dates?: Readonly<Record<string, string>>; log?: (message: string) => void;
}): {
  run<T>(phase: string, fn: () => Promise<T>): Promise<T>;
  snapshot(): Promise<unknown[]>;
  refusal(): Promise<void>;
};
export function realRefusalProbes(sql: (text: string) => Promise<string>, uid: string, families: readonly string[], options?: {
  dates?: Readonly<Record<string, string>>; log?: (message: string) => void;
}): Promise<string[]>;
