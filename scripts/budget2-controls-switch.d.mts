export const SWITCH_PROFILES: Readonly<{
  v2: Readonly<{ manifest: string; maxRequestMicro: number }>;
  v3: Readonly<{ manifest: string; maxRequestMicro: number }>;
}>;
export function switchControlsSql(ownerId: string, direction: 'forward' | 'rollback'): string;
