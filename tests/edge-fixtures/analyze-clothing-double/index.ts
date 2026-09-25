// CI-only PR-3b fixture entrypoint (EDGE-RUNTIME / PROVIDER-DOUBLE). Excluded from every deployment by
// scripts/check-deploy-artifacts.mjs. It runs the production analyze-clothing handler unchanged, with its injected
// azureTransport accepting only the exact pinned Azure request and forwarding it to the internal provider double.
import { createHandler } from '../../../supabase/functions/analyze-clothing/handler.ts';
import { AZURE_ENDPOINT } from '../../../supabase/functions/analyze-clothing/azure-openai.ts';

const DOUBLE = 'http://provider-double:8080';
const DUMMY_API_KEY = 'local-dummy-not-a-credential';

async function transport(input: string, init: RequestInit): Promise<Response> {
  if (input !== AZURE_ENDPOINT || init.method !== 'POST' || init.redirect !== 'error') {
    await fetch(`${DOUBLE}/rejected`, { method: 'POST', body: '{}' }).then((r) => r.body?.cancel(), () => undefined);
    throw new Error('EDGE fixture transport refused a non-pinned provider request');
  }
  return fetch(`${DOUBLE}/chat/completions`, { method: 'POST', redirect: 'error', cache: 'no-store',
    headers: init.headers, body: init.body, signal: init.signal });
}

Deno.serve(createHandler({
  supabaseUrl: 'http://kong:8000',
  publicKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  azure: { apiKey: DUMMY_API_KEY },
}, transport));
