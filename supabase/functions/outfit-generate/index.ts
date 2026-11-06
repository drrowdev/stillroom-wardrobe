import { createOutfitGenHandler, type OutfitGenRegistrar } from './handler.ts';

// The same Azure secret as photo analysis and the Stylist (AI_AZURE_OPENAI_API_KEY): one Terra deployment. The shared
// analyze-clothing Deno declaration lists only that function's names, so the runtime hook is read untyped.
// Supabase background tasks: the claimed work is registered with EdgeRuntime.waitUntil. When the runtime doesn't provide
// it, the handler claims nothing; a missing global is never treated as a fixture.
declare const EdgeRuntime: { waitUntil?: (work: Promise<unknown>) => void } | undefined;
const runtime = typeof EdgeRuntime === 'object' && EdgeRuntime !== null && typeof EdgeRuntime.waitUntil === 'function' ? EdgeRuntime : null;
const registrar: OutfitGenRegistrar | null = runtime ? (work) => runtime.waitUntil!(work) : null;
Deno.serve(createOutfitGenHandler({
  supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
  publicKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  azure: { apiKey: Deno.env.get('AI_AZURE_OPENAI_API_KEY') },
}, registrar));
