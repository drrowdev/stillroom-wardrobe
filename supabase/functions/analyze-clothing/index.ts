import { createHandler } from './handler.ts';

Deno.serve(createHandler({
  supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
  publicKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  google: {
    projectId: Deno.env.get('AI_GOOGLE_PROJECT_ID'),
    clientEmail: Deno.env.get('AI_GOOGLE_CLIENT_EMAIL'),
    privateKey: Deno.env.get('AI_GOOGLE_PRIVATE_KEY'),
  },
}));
