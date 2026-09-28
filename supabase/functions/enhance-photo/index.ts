import { createEnhanceHandler, type EnhanceRegistrar } from './handler.ts';

// AI_AZURE_IMAGE_API_KEY is a separate secret (M4): it can hold the other stillroom-ai-eval resource key for
// independent rotation, but either key has resource-wide scope. Not set until the owner approves activation.
// ENHANCE_PROBE_TOKEN exists only during an approved operator probe window and is deleted straight after it.
// The shared analyze-clothing Deno declaration lists only that function's names, so these are read untyped.
const env = Deno.env.get as (name: string) => string | undefined;
// Supabase background tasks: the claimed work is registered with EdgeRuntime.waitUntil. When the runtime doesn't
// provide it, the handler claims nothing (W1); a missing global is never treated as a fixture.
declare const EdgeRuntime: { waitUntil?: (work: Promise<unknown>) => void } | undefined;
const runtime = typeof EdgeRuntime === 'object' && EdgeRuntime !== null && typeof EdgeRuntime.waitUntil === 'function' ? EdgeRuntime : null;
const registrar: EnhanceRegistrar | null = runtime ? (work) => runtime.waitUntil!(work) : null;
Deno.serve(createEnhanceHandler({
  supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
  publicKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  azure: { apiKey: env('AI_AZURE_IMAGE_API_KEY') },
  probeToken: env('ENHANCE_PROBE_TOKEN') ?? null,
}, registrar));
