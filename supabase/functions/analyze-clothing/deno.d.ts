declare const Deno: {
  env: { get(name: 'SUPABASE_URL' | 'SUPABASE_ANON_KEY' | 'SUPABASE_SERVICE_ROLE_KEY'
    | 'AI_GOOGLE_PROJECT_ID' | 'AI_GOOGLE_CLIENT_EMAIL' | 'AI_GOOGLE_PRIVATE_KEY'): string | undefined };
  serve(handler: (request: Request) => Promise<Response>): void;
};
