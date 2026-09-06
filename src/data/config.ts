export type PublicConfig = { url: string; publishableKey: string; version: string };
export type Configuration = { status: 'ready'; value: PublicConfig } | { status: 'missing' | 'invalid' };

export function readConfiguration(values: Record<string, string | undefined>): Configuration {
  const address = values.VITE_SUPABASE_URL?.trim();
  const key = values.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!address && !key) return { status: 'missing' };
  if (!address || !key) return { status: 'invalid' };
  let url: URL;
  try { url = new URL(address); } catch { return { status: 'invalid' }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    return { status: 'invalid' };
  }
  if (key.startsWith('sb_secret_')) return { status: 'invalid' };
  if (!key.startsWith('sb_publishable_')) {
    try {
      const payload = key.split('.')[1];
      if (!payload) return { status: 'invalid' };
      const claims: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
      if (typeof claims !== 'object' || claims === null || !('role' in claims) || claims.role !== 'anon') {
        return { status: 'invalid' };
      }
    } catch { return { status: 'invalid' }; }
  }
  return { status: 'ready', value: { url: url.origin, publishableKey: key, version: values.VITE_APP_VERSION || '0.1.0' } };
}
