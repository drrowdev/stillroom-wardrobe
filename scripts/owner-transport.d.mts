export const REQUEST_TIMEOUT_MS: number;
export type TransportRequest = { method: string; path: string; rawPath: string; search: string; query: URLSearchParams; headers: Headers; body: unknown };
export type TransportState = { owner: string | null; refused: boolean; signal?: AbortSignal };
export type TransportPolicy = (request: TransportRequest, state: TransportState) => boolean | Promise<boolean>;
export const exportPolicy: TransportPolicy;
export const restorePolicy: TransportPolicy;
export const RESTORE_RPCS: readonly string[];
export const RESTORE_ROUTES: readonly string[];
export function ownerTransport(options: {
  origin: string; key: string; fetchImpl: (input: string, init: RequestInit) => Promise<Response>; state: TransportState;
  policy: TransportPolicy; refusal?: () => Error; observe?: (request: { method: string; path: string; search: string }) => unknown;
}): (input: string | URL | Request, init?: RequestInit) => Promise<Response>;