export type KnownFlake = Readonly<{ file: string; title: string; k2: string }>;
export type FlakeResult = { file: string; title: string; project: string; outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped' };
export function parseAllowlist(text: string): KnownFlake[];
export function judgeFlakes(results: FlakeResult[], allowlist: KnownFlake[]): { failed: boolean; warnings: string[]; errors: string[] };
