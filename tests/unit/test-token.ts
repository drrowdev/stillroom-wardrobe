// Fictional, unsigned access tokens shaped like Supabase JWTs. The app reads only their claims, locally.
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function testAccessToken(sub: string, options: { exp?: number; sessionId?: string; label?: string } = {}): string {
  const claims = {
    sub, role: 'authenticated', aud: 'authenticated',
    exp: options.exp ?? Math.floor(Date.now() / 1000) + 3600,
    session_id: options.sessionId ?? `${sub.slice(0, 8)}-session`,
    ...(options.label ? { jti: options.label } : {}),
  };
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.fictional-signature`;
}
