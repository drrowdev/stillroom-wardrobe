import { describe, expect, it } from 'vitest';
import { holdsStoredSession } from '../../src/auth/stored-session';

describe('per-tab stored session guard', () => {
  it('accepts only an exact readable access token', () => {
    expect(holdsStoredSession(JSON.stringify({ access_token: 'own-token' }), 'own-token')).toBe(true);
    expect(holdsStoredSession(JSON.stringify({ access_token: 'own-token' }), 'foreign-token')).toBe(false);
  });
  it.each(['own', 'token', 'own-token-extra'])('rejects prefix/substring mismatches: %s', (candidate) => {
    expect(holdsStoredSession(JSON.stringify({ access_token: 'own-token' }), candidate)).toBe(false);
  });
  it('does not accept a candidate embedded in a different JSON field', () => {
    const stored = JSON.stringify({ access_token: 'own-token', user: { note: 'foreign-token' } });
    expect(holdsStoredSession(stored, 'foreign-token')).toBe(false);
  });
  it.each([null, ''])('rejects a missing stored session: %s', (stored) => {
    expect(holdsStoredSession(stored, 'own-token')).toBe(false);
  });
  it('preserves the unparseable JSON policy', () => {
    expect(holdsStoredSession('unparseable', 'own-token')).toBe(true);
  });
  it.each(['null', '{}', '[]', '{"access_token":42}'])('preserves the missing/non-string access_token policy: %s', (stored) => {
    expect(holdsStoredSession(stored, 'own-token')).toBe(true);
  });
});
