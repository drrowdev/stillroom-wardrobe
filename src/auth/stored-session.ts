export function holdsStoredSession(stored: string | null, accessToken: string): boolean {
  if (!stored) return false;
  try {
    const value: unknown = JSON.parse(stored);
    // Preserve the existing policy for payloads without a readable token.
    if (typeof value !== 'object' || value === null || !('access_token' in value)) return true;
    return typeof value.access_token !== 'string' || value.access_token === accessToken;
  } catch { return true; }
}
