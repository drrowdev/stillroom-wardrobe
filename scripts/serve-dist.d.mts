export type HeaderRule = { pattern: string; headers: Array<[string, string]> };
export type DistServer = {
  url: string;
  requests: Array<{ method: string; pathname: string; mode: string; dest: string }>;
  setRoot(root: string): Promise<void>;
  hold(pathname: string): () => void;
  close(): Promise<void>;
};
export function parseHeaders(text: string): HeaderRule[];
export function headersFor(rules: HeaderRule[], pathname: string): Map<string, string>;
export function startDistServer(options: { root: string; port?: number; host?: string }): Promise<DistServer>;
export function contentTypeFor(file: string): string;
