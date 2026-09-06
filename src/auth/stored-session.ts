export function holdsStoredSession(stored: string | null, accessToken: string): boolean {
  if (!stored) return false;
  try {
    const value = JSON.parse(stored) as { access_token?: unknown } | null;
    // Preserve the existing policy for payloads without a readable token.
    return typeof value?.access_token !== 'string' || value.access_token === accessToken;
  } catch { return true; }
}
