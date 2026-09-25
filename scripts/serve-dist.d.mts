export type HeaderRule = { pattern: string; headers: Array<[string, string]> };
export type DistServer = {
  url: string;
  requests: Array<{ method: string; pathname: string; mode: string; dest: string; bytes: number; start: number; end: number }>;
  setRoot(root: string): Promise<void>;
  hold(pathname: string): () => void;
  close(): Promise<void>;
};
export function parseHeaders(text: string): HeaderRule[];
export function headersFor(rules: HeaderRule[], pathname: string): Map<string, string>;
export type LinkThrottle = { bytesPerSecond: number; latencyMs?: number };
export function createLink(throttle: LinkThrottle): { bytesPerSecond: number; latencyMs: number; send(response: import('node:http').ServerResponse, body: Buffer): Promise<void> };
export function startDistServer(options: { root: string; port?: number; host?: string; throttle?: LinkThrottle }): Promise<DistServer>;
export function contentTypeFor(file: string): string;
