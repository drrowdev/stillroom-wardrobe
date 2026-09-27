import { createEnhanceHandler } from './handler.ts';

// AI_AZURE_IMAGE_API_KEY is a separate secret (M4): it can hold the other stillroom-ai-eval resource key for
// independent rotation, but either key has resource-wide scope. Not set until the owner approves activation.
// The shared analyze-clothing Deno declaration lists only that function's names, so this one name is read untyped.
const imageKey = (Deno.env.get as (name: string) => string | undefined)('AI_AZURE_IMAGE_API_KEY');
Deno.serve(createEnhanceHandler({
  supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
  publicKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  azure: { apiKey: imageKey },
}));
