import { createTryOnHandler, type TryOnRegistrar } from './handler.ts';

// AI_AZURE_IMAGE_API_KEY is the photo-enhancement image secret: both features use the same deployment (ADR28). Not
// set for try-on use until the owner approves activation. TRYON_PROBE_TOKEN exists only during an approved operator
// probe window and is deleted straight after it. The shared analyze-clothing Deno declaration lists only that
// function's names, so these are read untyped.
const env = Deno.env.get as (name: string) => string | undefined;
// Supabase background tasks: the claimed work is registered with EdgeRuntime.waitUntil. When the runtime doesn't
// provide it, the handler claims nothing (W1); a missing global is never treated as a fixture.
declare const EdgeRuntime: { waitUntil?: (work: Promise<unknown>) => void } | undefined;
const runtime = typeof EdgeRuntime === 'object' && EdgeRuntime !== null && typeof EdgeRuntime.waitUntil === 'function' ? EdgeRuntime : null;
const registrar: TryOnRegistrar | null = runtime ? (work) => runtime.waitUntil!(work) : null;
Deno.serve(createTryOnHandler({
  supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
  publicKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  azure: { apiKey: env('AI_AZURE_IMAGE_API_KEY') },
  probeToken: env('TRYON_PROBE_TOKEN') ?? null,
}, registrar));
