import { describe, expect, it } from 'vitest';
import { holdsStoredSession } from '../../src/auth/stored-session';

const record = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ access_token: 'own-token', refresh_token: 'own-refresh', expires_at: 1_900_000_000, ...fields });

describe('per-tab stored session guard', () => {
  it('accepts only an exact readable access token', () => {
    expect(holdsStoredSession(record(), 'own-token')).toBe(true);
    expect(holdsStoredSession(record(), 'foreign-token')).toBe(false);
  });
  it.each(['own', 'token', 'own-token-extra', ''])('rejects prefix/substring mismatches: %s', (candidate) => {
    expect(holdsStoredSession(record(), candidate)).toBe(false);
  });
  it('does not accept a candidate embedded in a different JSON field', () => {
    expect(holdsStoredSession(record({ user: { note: 'foreign-token' } }), 'foreign-token')).toBe(false);
  });
  it.each([null, ''])('rejects a missing stored session: %s', (stored) => {
    expect(holdsStoredSession(stored, 'own-token')).toBe(false);
  });
  // Fail-closed: anything but the exact allowlisted record holds nothing.
  it.each([
    'unparseable', 'null', '{}', '[]', '"text"', '42', 'true', '{"access_token":42}', '{"access_token":"own-token"}',
    record({ user: { id: 'x' } }), record({ refresh_token: '' }), record({ expires_at: 'soon' }), record({ expires_at: 1.5 }),
  ])('rejects a malformed, tokenless or extra-field record: %s', (stored) => {
    expect(holdsStoredSession(stored, 'own-token')).toBe(false);
  });
});
