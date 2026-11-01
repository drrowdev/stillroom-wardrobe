// Types for the SQL generators that tests/unit/synthetic-analysis-fixture.test.ts pins against the historical migrations.
export function syntheticClaimSql(shape: {
  owner: string; requestId: string; draftId: string; generation: number; hash: string; bytes: number; width: number;
  height: number; manifest: string;
}): string;
export function syntheticFinishSql(shape: {
  owner: string; requestId: string; manifest: string; facts: unknown; usage: unknown;
}): string;
export function syntheticSaveSql(shape: { owner: string; item: unknown; image: unknown; claim: unknown; manifest: string }): string;
export function syntheticImageChangeSql(shape: { owner: string; intent: unknown; manifest: string }): string;
