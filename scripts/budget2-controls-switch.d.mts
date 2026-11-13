export const CURRENT_PERIOD_SQL: string;
export const SWITCH_PROFILES: Readonly<{
  v2: Readonly<{ manifest: string; maxRequestMicro: number; promptVersion: number }>;
  v3: Readonly<{ manifest: string; maxRequestMicro: number; promptVersion: number }>;
  v4: Readonly<{ manifest: string; maxRequestMicro: number; promptVersion: number }>;
}>;
export function switchControlsSql(ownerId: string, direction: 'forward' | 'rollback'): string;
export function switchManifestSql(ownerId: string, fromKey: 'v3' | 'v4', toKey: 'v3' | 'v4'): string;
