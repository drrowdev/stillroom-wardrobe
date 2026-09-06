import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';
import type { PublicConfig } from './config';

export type AppClient = SupabaseClient<Database>;
export const authStorageKey = 'stillroom.auth';
const requestContexts = new WeakMap<AppClient, { signal?: AbortSignal }>();
const clients = new Map<string, AppClient>();
export function makeClient(config: PublicConfig): AppClient {
  const identity = `${config.url}|${config.publishableKey}`;
  const existing = clients.get(identity);
  if (existing) return existing;
  const context: { signal?: AbortSignal } = {};
  const client = createClient<Database>(config.url, config.publishableKey, {
    auth: {
      storage: window.sessionStorage,
      storageKey: authStorageKey,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
    global: {
      fetch: (input, init) => {
        const address = input instanceof Request ? input.url : String(input);
        const signals = [AbortSignal.timeout(20_000)];
        if (init?.signal) signals.push(init.signal);
        if (context.signal && !new URL(address).pathname.startsWith('/auth/v1/')) signals.push(context.signal);
        return fetch(input, { ...init, cache: 'no-store', signal: AbortSignal.any(signals) });
      },
    },
  });
  requestContexts.set(client, context);
  clients.set(identity, client);
  return client;
}
export function bindDataRequests(client: AppClient, signal: AbortSignal): void {
  const context = requestContexts.get(client);
  if (context) context.signal = signal;
}
