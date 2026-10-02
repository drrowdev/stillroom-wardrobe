import { readAuthRecord } from './auth-storage';

/** True only when the store holds an allowlisted record for exactly this access token. Anything else fails closed. */
export function holdsStoredSession(stored: string | null, accessToken: string): boolean {
  const record = readAuthRecord(stored);
  return record !== null && accessToken.length > 0 && record.access_token === accessToken;
}
