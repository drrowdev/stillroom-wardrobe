export interface ChromiumProcess { pid: number; exe: string | null; command: string | null; status: string | null }
export function pinnedChromium(): Promise<{ path?: string; problem?: string }>;
export class ProcessReadError extends Error { pid: number; code: string }
export function descendantsOf(root: number, proc?: string, read?: (path: string, encoding: 'utf8') => string): ChromiumProcess[];
export function hasFlag(command: string | null, flag: string): boolean;