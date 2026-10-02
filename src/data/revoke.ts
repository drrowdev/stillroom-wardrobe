import type { PublicConfig } from './config';
import type { AuthRecord } from '../auth/auth-storage';
import { REQUEST_TIMEOUT_MS, type RevokeResult } from './client';

// Loaded only when a sign-out needs it, to keep the first download small.
async function errorCode(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json();
    if (typeof value !== 'object' || value === null) return '';
    const code = 'error_code' in value ? value.error_code : 'code' in value ? value.code : '';
    return typeof code === 'string' ? code : '';
  } catch { return ''; }
}
const goneCodes = ['session_not_found', 'user_not_found'];
const deadRefreshCodes = ['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired', 'user_not_found'];
/**
 * Best-effort server logout for a captured record. Done only when the server confirms the session is gone (or was
 * already gone). An expired access token is renewed first, off any client, so the logout can be authorised.
 */
export async function revokeSession(config: PublicConfig, record: AuthRecord | null): Promise<RevokeResult> {
  if (!record) return 'ok';
  const request = (path: string, init: RequestInit) => fetch(`${config.url}${path}`, {
    ...init, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  try {
    let token = record.access_token;
    if (record.expires_at * 1000 <= Date.now() + 5_000) {
      const renewed = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', headers: { apikey: config.publishableKey, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: record.refresh_token }),
      });
      if (!renewed.ok) {
        // A refresh token the server no longer knows means there is no session left to end.
        return renewed.status === 400 && deadRefreshCodes.includes(await errorCode(renewed)) ? 'ok' : 'failed';
      }
      const body: unknown = await renewed.json().catch(() => null);
      const fresh = typeof body === 'object' && body !== null && 'access_token' in body ? body.access_token : null;
      if (typeof fresh !== 'string' || !fresh) return 'failed';
      token = fresh;
    }
    const response = await request('/auth/v1/logout?scope=local', {
      method: 'POST', headers: { apikey: config.publishableKey, authorization: `Bearer ${token}` },
    });
    if (response.ok || response.status === 404) { await response.body?.cancel().catch(() => undefined); return 'ok'; }
    return response.status === 403 && goneCodes.includes(await errorCode(response)) ? 'ok' : 'failed';
  } catch { return 'failed'; }
}
